'use strict';
import * as fs from 'fs';
import * as paths from 'path';
import {
    ConfigurationChangeEvent,
    Disposable,
    Event,
    EventEmitter,
    extensions,
    Range,
    TextEditor,
    Uri,
    window,
    WindowState,
    workspace,
    WorkspaceFolder,
    WorkspaceFoldersChangeEvent
} from 'vscode';
import { GitExtension } from '../@types/git';
import { configuration, RemotesConfig } from '../configuration';
import { CommandContext, DocumentSchemes, GlyphChars, setCommandContext } from '../constants';
import { Container } from '../container';
import { Logger } from '../logger';
import { Iterables, Objects, Strings, TernarySearchTree, Versions } from '../system';
import { CachedBlame, CachedDiff, CachedLog, GitDocumentState, TrackedDocument } from '../trackers/gitDocumentTracker';
import {
    CommitFormatting,
    Git,
    GitAuthor,
    GitBlame,
    GitBlameCommit,
    GitBlameLine,
    GitBlameLines,
    GitBlameParser,
    GitBranch,
    GitBranchParser,
    GitCommit,
    GitCommitType,
    GitDiff,
    GitDiffChunkLine,
    GitDiffParser,
    GitDiffShortStat,
    GitFile,
    GitLog,
    GitLogCommit,
    GitLogParser,
    GitRemote,
    GitRemoteParser,
    GitStash,
    GitStashParser,
    GitStatus,
    GitStatusFile,
    GitStatusParser,
    GitTag,
    GitTagParser,
    GitTree,
    GitTreeParser,
    Repository,
    RepositoryChange
} from './git';
import { GitUri } from './gitUri';
import { RemoteProviderFactory, RemoteProviderMap } from './remotes/factory';

export * from './gitUri';
export * from './models/models';
export * from './formatters/formatters';
export { getNameFromRemoteResource, RemoteProvider, RemoteResource, RemoteResourceType } from './remotes/provider';
export { RemoteProviderFactory } from './remotes/factory';

const RepoSearchWarnings = {
    doesNotExist: /no such file or directory/i
};

const userConfigRegex = /^user\.(name|email) (.*)$/gm;
const mappedAuthorRegex = /(.+)\s<(.+)>/;

export enum GitRepoSearchBy {
    Author = 'author',
    ChangedLines = 'changed-lines',
    Changes = 'changes',
    Files = 'files',
    Message = 'message',
    Sha = 'sha'
}

export class GitService implements Disposable {
    static emptyPromise: Promise<GitBlame | GitDiff | GitLog | undefined> = Promise.resolve(undefined);
    static deletedOrMissingSha = Git.deletedOrMissingSha;
    static stagedUncommittedSha = Git.stagedUncommittedSha;
    static uncommittedSha = Git.uncommittedSha;

    private _onDidChangeRepositories = new EventEmitter<void>();
    get onDidChangeRepositories(): Event<void> {
        return this._onDidChangeRepositories.event;
    }

    private readonly _disposable: Disposable;
    private readonly _repositoryTree: TernarySearchTree<Repository>;
    private _repositoriesLoadingPromise: Promise<void> | undefined;
    private _suspended: boolean = false;
    private readonly _trackedCache: Map<string, boolean | Promise<boolean>>;

    constructor() {
        this._repositoryTree = TernarySearchTree.forPaths();
        this._trackedCache = new Map();

        this._disposable = Disposable.from(
            window.onDidChangeWindowState(this.onWindowStateChanged, this),
            workspace.onDidChangeWorkspaceFolders(this.onWorkspaceFoldersChanged, this),
            configuration.onDidChange(this.onConfigurationChanged, this)
        );
        this.onConfigurationChanged(configuration.initializingChangeEvent);

        this._repositoriesLoadingPromise = this.onWorkspaceFoldersChanged();
    }

    dispose() {
        this._repositoryTree.forEach(r => r.dispose());
        this._trackedCache.clear();

        this._disposable && this._disposable.dispose();
    }

    get UseCaching() {
        return Container.config.advanced.caching.enabled;
    }

    private onAnyRepositoryChanged(repo: Repository, reason: RepositoryChange) {
        this._trackedCache.clear();

        if (reason === RepositoryChange.Config) {
            this._userMapCache.delete(repo.path);
        }

        if (reason === RepositoryChange.Closed) {
            // Send a notification that the repositories changed
            setImmediate(async () => {
                await this.updateContext(this._repositoryTree);

                this.fireRepositoriesChanged();
            });
        }
    }

    private onConfigurationChanged(e: ConfigurationChangeEvent) {
        const initializing = configuration.initializing(e);

        if (
            initializing ||
            configuration.changed(e, configuration.name('defaultDateStyle').value) ||
            configuration.changed(e, configuration.name('defaultDateFormat').value)
        ) {
            CommitFormatting.reset();
        }
    }

    private onWindowStateChanged(e: WindowState) {
        if (e.focused) {
            this._repositoryTree.forEach(r => r.resume());
        }
        else {
            this._repositoryTree.forEach(r => r.suspend());
        }

        this._suspended = !e.focused;
    }

    private async onWorkspaceFoldersChanged(e?: WorkspaceFoldersChangeEvent) {
        let initializing = false;
        if (e === undefined) {
            initializing = true;
            e = {
                added: workspace.workspaceFolders || [],
                removed: []
            } as WorkspaceFoldersChangeEvent;

            Logger.log(`Starting repository search in ${e.added.length} folders`);
        }

        for (const f of e.added) {
            if (f.uri.scheme !== DocumentSchemes.File) continue;

            // Search for and add all repositories (nested and/or submodules)
            const repositories = await this.repositorySearch(f);
            for (const r of repositories) {
                this._repositoryTree.set(r.path, r);
            }
        }

        for (const f of e.removed) {
            if (f.uri.scheme !== DocumentSchemes.File) continue;

            const fsPath = f.uri.fsPath;
            const repos = this._repositoryTree.findSuperstr(fsPath);
            const reposToDelete =
                repos !== undefined
                    ? // Since the filtered tree will have keys that are relative to the fsPath, normalize to the full path
                      [...Iterables.map<Repository, [Repository, string]>(repos, r => [r, r.path])]
                    : [];

            // const filteredTree = this._repositoryTree.findSuperstr(fsPath);
            // const reposToDelete =
            //     filteredTree !== undefined
            //         ? // Since the filtered tree will have keys that are relative to the fsPath, normalize to the full path
            //           [
            //               ...Iterables.map<[Repository, string], [Repository, string]>(
            //                   filteredTree.entries(),
            //                   ([r, k]) => [r, path.join(fsPath, k)]
            //               )
            //           ]
            //         : [];

            const repo = this._repositoryTree.get(fsPath);
            if (repo !== undefined) {
                reposToDelete.push([repo, fsPath]);
            }

            for (const [r, k] of reposToDelete) {
                this._repositoryTree.delete(k);
                r.dispose();
            }
        }

        await this.updateContext(this._repositoryTree);

        if (!initializing) {
            // Defer the event trigger enough to let everything unwind
            setImmediate(() => this.fireRepositoriesChanged());
        }
    }

    private async repositorySearch(folder: WorkspaceFolder): Promise<Repository[]> {
        const folderUri = folder.uri;

        const depth = configuration.get<number>(
            configuration.name('advanced')('repositorySearchDepth').value,
            folderUri
        );

        Logger.log(`Searching for repositories (depth=${depth}) in '${folderUri.fsPath}' ...`);

        const start = process.hrtime();

        const repositories: Repository[] = [];
        const anyRepoChangedFn = this.onAnyRepositoryChanged.bind(this);

        const rootPath = await this.getRepoPathCore(folderUri.fsPath, true);
        if (rootPath !== undefined) {
            Logger.log(`Repository found in '${rootPath}'`);
            repositories.push(new Repository(folder, rootPath, true, anyRepoChangedFn, this._suspended));
        }

        if (depth <= 0) {
            Logger.log(
                `Completed repository search (depth=${depth}) in '${folderUri.fsPath}' ${
                    GlyphChars.Dot
                } ${Strings.getDurationMilliseconds(start)} ms`
            );

            return repositories;
        }

        // Get any specified excludes -- this is a total hack, but works for some simple cases and something is better than nothing :)
        let excludes = {
            ...workspace.getConfiguration('files', folderUri).get<{ [key: string]: boolean }>('exclude', {}),
            ...workspace.getConfiguration('search', folderUri).get<{ [key: string]: boolean }>('exclude', {})
        };

        const excludedPaths = [
            ...Iterables.filterMap(Objects.entries(excludes), ([key, value]) => {
                if (!value) return undefined;
                if (key.startsWith('**/')) return key.substring(3);
                return key;
            })
        ];

        excludes = excludedPaths.reduce(
            (accumulator, current) => {
                accumulator[current] = true;
                return accumulator;
            },
            Object.create(null) as any
        );

        let repoPaths;
        try {
            repoPaths = await this.repositorySearchCore(folderUri.fsPath, depth, excludes);
        }
        catch (ex) {
            if (RepoSearchWarnings.doesNotExist.test(ex.message || '')) {
                Logger.log(
                    `Repository search (depth=${depth}) in '${folderUri.fsPath}' FAILED${
                        ex.message ? `(${ex.message})` : ''
                    }`
                );
            }
            else {
                Logger.error(ex, `Repository search (depth=${depth}) in '${folderUri.fsPath}' FAILED`);
            }

            return repositories;
        }

        for (let p of repoPaths) {
            p = paths.dirname(p);
            // If we are the same as the root, skip it
            if (Strings.normalizePath(p) === rootPath) continue;

            const rp = await this.getRepoPathCore(p, true);
            if (rp === undefined) continue;

            Logger.log(`Repository found in '${rp}'`);
            repositories.push(new Repository(folder, rp, false, anyRepoChangedFn, this._suspended));
        }

        Logger.log(
            `Completed repository search (depth=${depth}) in '${folderUri.fsPath}' ${
                GlyphChars.Dot
            } ${Strings.getDurationMilliseconds(start)} ms`
        );

        return repositories;
    }

    private async repositorySearchCore(
        root: string,
        depth: number,
        excludes: { [key: string]: boolean },
        repositories: string[] = []
    ): Promise<string[]> {
        return new Promise<string[]>((resolve, reject) => {
            fs.readdir(root, async (err, files) => {
                if (err != null) {
                    reject(err);
                    return;
                }

                if (files.length === 0) {
                    resolve(repositories);
                    return;
                }

                const folders: string[] = [];

                const promises = files.map(file => {
                    const path = paths.resolve(root, file);

                    return new Promise<void>((res, rej) => {
                        fs.stat(path, (err, stat) => {
                            if (file === '.git') {
                                repositories.push(path);
                            }
                            else if (err == null && excludes[file] !== true && stat != null && stat.isDirectory()) {
                                folders.push(path);
                            }

                            res();
                        });
                    });
                });

                await Promise.all(promises);

                if (depth-- > 0) {
                    for (const folder of folders) {
                        await this.repositorySearchCore(folder, depth, excludes, repositories);
                    }
                }

                resolve(repositories);
            });
        });
    }

    private async updateContext(repositoryTree: TernarySearchTree<Repository>) {
        const hasRepository = repositoryTree.any();
        await setCommandContext(CommandContext.Enabled, hasRepository);

        let hasRemotes = false;
        if (hasRepository) {
            for (const repo of repositoryTree.values()) {
                hasRemotes = await repo.hasRemotes();
                if (hasRemotes) break;
            }
        }

        await setCommandContext(CommandContext.HasRemotes, hasRemotes);

        // If we have no repositories setup a watcher in case one is initialized
        if (!hasRepository) {
            const watcher = workspace.createFileSystemWatcher('**/.git', false, true, true);
            const disposable = Disposable.from(
                watcher,
                watcher.onDidCreate(async uri => {
                    const f = workspace.getWorkspaceFolder(uri);
                    if (f === undefined) return;

                    // Search for and add all repositories (nested and/or submodules)
                    const repositories = await this.repositorySearch(f);
                    if (repositories.length === 0) return;

                    disposable.dispose();

                    for (const r of repositories) {
                        this._repositoryTree.set(r.path, r);
                    }

                    await this.updateContext(this._repositoryTree);

                    // Defer the event trigger enough to let everything unwind
                    setImmediate(() => this.fireRepositoriesChanged());
                }, this)
            );
        }
    }

    private fireRepositoriesChanged() {
        this._onDidChangeRepositories.fire();
    }

    checkoutFile(uri: GitUri, ref?: string) {
        ref = ref || uri.sha;
        Logger.log(`checkoutFile('${uri.repoPath}', '${uri.fsPath}', '${ref}')`);

        return Git.checkout(uri.repoPath!, uri.fsPath, ref!);
    }

    private async fileExists(
        repoPath: string,
        fileName: string,
        options: { ensureCase: boolean } = { ensureCase: false }
    ): Promise<boolean> {
        const path = paths.resolve(repoPath, fileName);
        const exists = await new Promise<boolean>((resolve, reject) => fs.exists(path, resolve));
        if (!options.ensureCase || !exists) return exists;

        // Deal with renames in case only on case-insensative file systems
        const normalizedRepoPath = paths.normalize(repoPath);
        return this.fileExistsWithCase(path, normalizedRepoPath, normalizedRepoPath.length);
    }

    private async fileExistsWithCase(path: string, repoPath: string, repoPathLength: number): Promise<boolean> {
        const dir = paths.dirname(path);
        if (dir.length < repoPathLength) return false;
        if (dir === repoPath) return true;

        const filenames = await new Promise<string[]>((resolve, reject) =>
            fs.readdir(dir, (err: NodeJS.ErrnoException, files: string[]) => {
                if (err) {
                    reject(err);
                }
                else {
                    resolve(files);
                }
            })
        );
        if (filenames.indexOf(paths.basename(path)) === -1) {
            return false;
        }
        return this.fileExistsWithCase(dir, repoPath, repoPathLength);
    }

    async findNextCommit(repoPath: string, fileName: string, ref?: string): Promise<GitLogCommit | undefined> {
        let log = await this.getLogForFile(repoPath, fileName, { maxCount: 1, ref: ref, renames: true, reverse: true });
        let commit = log && Iterables.first(log.commits.values());
        if (commit) return commit;

        const nextFileName = await this.findNextFileName(repoPath, fileName, ref);
        if (nextFileName) {
            log = await this.getLogForFile(repoPath, nextFileName, {
                maxCount: 1,
                ref: ref,
                renames: true,
                reverse: true
            });
            commit = log && Iterables.first(log.commits.values());
        }

        return commit;
    }

    async findNextFileName(repoPath: string | undefined, fileName: string, ref?: string): Promise<string | undefined> {
        [fileName, repoPath] = Git.splitPath(fileName, repoPath);

        return (await this.fileExists(repoPath, fileName, { ensureCase: true }))
            ? fileName
            : await this.findNextFileNameCore(repoPath, fileName, ref);
    }

    private async findNextFileNameCore(repoPath: string, fileName: string, ref?: string): Promise<string | undefined> {
        if (ref === undefined) {
            // Get the most recent commit for this file name
            ref = await this.getRecentShaForFile(repoPath, fileName);
            if (ref === undefined) return undefined;
        }

        // Get the full commit (so we can see if there are any matching renames in the files)
        const log = await this.getLog(repoPath, { maxCount: 1, ref: ref });
        if (log === undefined) return undefined;

        const c = Iterables.first(log.commits.values());
        const file = c.files.find(f => f.originalFileName === fileName);
        if (file === undefined) return undefined;

        return file.fileName;
    }

    async findWorkingFileName(commit: GitCommit): Promise<[string | undefined, string | undefined]>;
    async findWorkingFileName(
        fileName: string,
        repoPath?: string,
        ref?: string
    ): Promise<[string | undefined, string | undefined]>;
    async findWorkingFileName(
        commitOrFileName: GitCommit | string,
        repoPath?: string,
        ref?: string
    ): Promise<[string | undefined, string | undefined]> {
        let fileName;
        if (typeof commitOrFileName === 'string') {
            fileName = commitOrFileName;
            if (repoPath === undefined) {
                repoPath = await this.getRepoPath(fileName, { ref: ref });
                [fileName, repoPath] = Git.splitPath(fileName, repoPath);
            }
            else {
                fileName = Strings.normalizePath(paths.relative(repoPath, fileName));
            }
        }
        else {
            const c = commitOrFileName;
            repoPath = c.repoPath;
            if (c.workingFileName && (await this.fileExists(repoPath, c.workingFileName, { ensureCase: true }))) {
                return [c.workingFileName, repoPath];
            }
            fileName = c.fileName;
        }

        // Keep walking up to the most recent commit for a given filename, until it exists on disk
        while (true) {
            if (await this.fileExists(repoPath, fileName, { ensureCase: true })) return [fileName, repoPath];

            fileName = await this.findNextFileNameCore(repoPath, fileName);
            if (fileName === undefined) return [undefined, undefined];
        }
    }

    async getActiveRepoPath(editor?: TextEditor): Promise<string | undefined> {
        editor = editor || window.activeTextEditor;

        let repoPath;
        if (editor != null) {
            const doc = await Container.tracker.getOrAdd(editor.document.uri);
            if (doc !== undefined) {
                repoPath = doc.uri.repoPath;
            }
        }

        if (repoPath != null) return repoPath;

        return this.getHighlanderRepoPath();
    }

    getHighlanderRepoPath(): string | undefined {
        const entry = this._repositoryTree.highlander();
        if (entry === undefined) return undefined;

        const [repo] = entry;
        return repo.path;
    }

    async getBlameForFile(uri: GitUri): Promise<GitBlame | undefined> {
        let key = 'blame';
        if (uri.sha !== undefined) {
            key += `:${uri.sha}`;
        }

        const doc = await Container.tracker.getOrAdd(uri);
        if (this.UseCaching) {
            if (doc.state !== undefined) {
                const cachedBlame = doc.state.get<CachedBlame>(key);
                if (cachedBlame !== undefined) {
                    Logger.log(`getBlameForFile[Cached(${key})]('${uri.repoPath}', '${uri.fsPath}', '${uri.sha}')`);
                    return cachedBlame.item;
                }
            }

            Logger.log(`getBlameForFile[Not Cached(${key})]('${uri.repoPath}', '${uri.fsPath}', '${uri.sha}')`);

            if (doc.state === undefined) {
                doc.state = new GitDocumentState(doc.key);
            }
        }
        else {
            Logger.log(`getBlameForFile('${uri.repoPath}', '${uri.fsPath}', '${uri.sha}')`);
        }

        const promise = this.getBlameForFileCore(uri, doc, key);

        if (doc.state !== undefined) {
            Logger.log(`Add blame cache for '${doc.state.key}:${key}'`);

            doc.state.set<CachedBlame>(key, {
                item: promise
            } as CachedBlame);
        }

        return promise;
    }

    private async getBlameForFileCore(
        uri: GitUri,
        document: TrackedDocument<GitDocumentState>,
        key: string
    ): Promise<GitBlame | undefined> {
        if (!(await this.isTracked(uri))) {
            Logger.log(`Skipping blame; '${uri.fsPath}' is not tracked`);
            return GitService.emptyPromise as Promise<GitBlame>;
        }

        const [file, root] = Git.splitPath(uri.fsPath, uri.repoPath, false);

        try {
            const data = await Git.blame(root, file, uri.sha, {
                args: Container.config.advanced.blame.customArguments,
                ignoreWhitespace: Container.config.blame.ignoreWhitespace
            });
            const blame = GitBlameParser.parse(data, root, file, await this.getCurrentUser(root));
            return blame;
        }
        catch (ex) {
            // Trap and cache expected blame errors
            if (document.state !== undefined) {
                const msg = ex && ex.toString();
                Logger.log(`Replace blame cache with empty promise for '${document.state.key}:${key}'`);

                document.state.set<CachedBlame>(key, {
                    item: GitService.emptyPromise,
                    errorMessage: msg
                } as CachedBlame);

                document.setBlameFailure();

                return GitService.emptyPromise as Promise<GitBlame>;
            }

            return undefined;
        }
    }

    async getBlameForFileContents(uri: GitUri, contents: string): Promise<GitBlame | undefined> {
        const key = `blame:${Strings.sha1(contents)}`;

        const doc = await Container.tracker.getOrAdd(uri);
        if (this.UseCaching) {
            if (doc.state !== undefined) {
                const cachedBlame = doc.state.get<CachedBlame>(key);
                if (cachedBlame !== undefined) {
                    Logger.log(
                        `getBlameForFileContents[Cached(${key})]('${uri.repoPath}', '${uri.fsPath}', '${uri.sha}')`
                    );
                    return cachedBlame.item;
                }
            }

            Logger.log(`getBlameForFileContents[Not Cached(${key})]('${uri.repoPath}', '${uri.fsPath}', '${uri.sha}')`);

            if (doc.state === undefined) {
                doc.state = new GitDocumentState(doc.key);
            }
        }
        else {
            Logger.log(`getBlameForFileContents('${uri.repoPath}', '${uri.fsPath}', '${uri.sha}')`);
        }

        const promise = this.getBlameForFileContentsCore(uri, contents, doc, key);

        if (doc.state !== undefined) {
            Logger.log(`Add blame cache for '${doc.state.key}:${key}'`);

            doc.state.set<CachedBlame>(key, {
                item: promise
            } as CachedBlame);
        }

        return promise;
    }

    async getBlameForFileContentsCore(
        uri: GitUri,
        contents: string,
        document: TrackedDocument<GitDocumentState>,
        key: string
    ): Promise<GitBlame | undefined> {
        if (!(await this.isTracked(uri))) {
            Logger.log(`Skipping blame; '${uri.fsPath}' is not tracked`);
            return GitService.emptyPromise as Promise<GitBlame>;
        }

        const [file, root] = Git.splitPath(uri.fsPath, uri.repoPath, false);

        try {
            const data = await Git.blame_contents(root, file, contents, {
                args: Container.config.advanced.blame.customArguments,
                correlationKey: `:${key}`,
                ignoreWhitespace: Container.config.blame.ignoreWhitespace
            });
            const blame = GitBlameParser.parse(data, root, file, await this.getCurrentUser(root));
            return blame;
        }
        catch (ex) {
            // Trap and cache expected blame errors
            if (document.state !== undefined) {
                const msg = ex && ex.toString();
                Logger.log(`Replace blame cache with empty promise for '${document.state.key}:${key}'`);

                document.state.set<CachedBlame>(key, {
                    item: GitService.emptyPromise,
                    errorMessage: msg
                } as CachedBlame);

                document.setBlameFailure();
                return GitService.emptyPromise as Promise<GitBlame>;
            }

            return undefined;
        }
    }

    async getBlameForLine(
        uri: GitUri,
        line: number,
        options: { skipCache?: boolean } = {}
    ): Promise<GitBlameLine | undefined> {
        Logger.log(`getBlameForLine('${uri.repoPath}', '${uri.fsPath}', '${uri.sha}', ${line})`);

        if (!options.skipCache && this.UseCaching) {
            const blame = await this.getBlameForFile(uri);
            if (blame === undefined) return undefined;

            let blameLine = blame.lines[line];
            if (blameLine === undefined) {
                if (blame.lines.length !== line) return undefined;
                blameLine = blame.lines[line - 1];
            }

            const commit = blame.commits.get(blameLine.sha);
            if (commit === undefined) return undefined;

            return {
                author: { ...blame.authors.get(commit.author), lineCount: commit.lines.length },
                commit: commit,
                line: blameLine
            } as GitBlameLine;
        }

        const lineToBlame = line + 1;
        const fileName = uri.fsPath;

        try {
            const data = await Git.blame(uri.repoPath, fileName, uri.sha, {
                args: Container.config.advanced.blame.customArguments,
                ignoreWhitespace: Container.config.blame.ignoreWhitespace,
                startLine: lineToBlame,
                endLine: lineToBlame
            });
            const blame = GitBlameParser.parse(data, uri.repoPath, fileName, await this.getCurrentUser(uri.repoPath!));
            if (blame === undefined) return undefined;

            return {
                author: Iterables.first(blame.authors.values()),
                commit: Iterables.first(blame.commits.values()),
                line: blame.lines[line]
            } as GitBlameLine;
        }
        catch {
            return undefined;
        }
    }

    async getBlameForLineContents(
        uri: GitUri,
        line: number,
        contents: string,
        options: { skipCache?: boolean } = {}
    ): Promise<GitBlameLine | undefined> {
        Logger.log(`getBlameForLineContents('${uri.repoPath}', '${uri.fsPath}', ${line})`);

        if (!options.skipCache && this.UseCaching) {
            const blame = await this.getBlameForFileContents(uri, contents);
            if (blame === undefined) return undefined;

            let blameLine = blame.lines[line];
            if (blameLine === undefined) {
                if (blame.lines.length !== line) return undefined;
                blameLine = blame.lines[line - 1];
            }

            const commit = blame.commits.get(blameLine.sha);
            if (commit === undefined) return undefined;

            return {
                author: { ...blame.authors.get(commit.author), lineCount: commit.lines.length },
                commit: commit,
                line: blameLine
            } as GitBlameLine;
        }

        const lineToBlame = line + 1;
        const fileName = uri.fsPath;

        try {
            const data = await Git.blame_contents(uri.repoPath, fileName, contents, {
                args: Container.config.advanced.blame.customArguments,
                ignoreWhitespace: Container.config.blame.ignoreWhitespace,
                startLine: lineToBlame,
                endLine: lineToBlame
            });
            const currentUser = await this.getCurrentUser(uri.repoPath!);
            const blame = GitBlameParser.parse(data, uri.repoPath, fileName, currentUser);
            if (blame === undefined) return undefined;

            return {
                author: Iterables.first(blame.authors.values()),
                commit: Iterables.first(blame.commits.values()),
                line: blame.lines[line]
            } as GitBlameLine;
        }
        catch {
            return undefined;
        }
    }

    async getBlameForRange(uri: GitUri, range: Range): Promise<GitBlameLines | undefined> {
        Logger.log(
            `getBlameForRange('${uri.repoPath}', '${uri.fsPath}', '${uri.sha}', [${range.start.line}, ${
                range.end.line
            }])`
        );

        const blame = await this.getBlameForFile(uri);
        if (blame === undefined) return undefined;

        return this.getBlameForRangeSync(blame, uri, range);
    }

    getBlameForRangeSync(blame: GitBlame, uri: GitUri, range: Range): GitBlameLines | undefined {
        Logger.log(
            `getBlameForRangeSync('${uri.repoPath}', '${uri.fsPath}', '${uri.sha}', [${range.start.line}, ${
                range.end.line
            }])`
        );

        if (blame.lines.length === 0) return { allLines: blame.lines, ...blame };

        if (range.start.line === 0 && range.end.line === blame.lines.length - 1) {
            return { allLines: blame.lines, ...blame };
        }

        const lines = blame.lines.slice(range.start.line, range.end.line + 1);
        const shas = new Set(lines.map(l => l.sha));

        const authors: Map<string, GitAuthor> = new Map();
        const commits: Map<string, GitBlameCommit> = new Map();
        for (const c of blame.commits.values()) {
            if (!shas.has(c.sha)) continue;

            const commit = c.with({
                lines: c.lines.filter(l => l.line >= range.start.line && l.line <= range.end.line)
            });
            commits.set(c.sha, commit);

            let author = authors.get(commit.author);
            if (author === undefined) {
                author = {
                    name: commit.author,
                    lineCount: 0
                };
                authors.set(author.name, author);
            }

            author.lineCount += commit.lines.length;
        }

        const sortedAuthors = new Map([...authors.entries()].sort((a, b) => b[1].lineCount - a[1].lineCount));

        return {
            authors: sortedAuthors,
            commits: commits,
            lines: lines,
            allLines: blame.lines
        } as GitBlameLines;
    }

    async getBranch(repoPath: string | undefined): Promise<GitBranch | undefined> {
        if (repoPath === undefined) return undefined;

        Logger.log(`getBranch('${repoPath}')`);

        const data = await Git.revparse_currentBranch(repoPath);
        if (data === undefined) return undefined;

        const branch = data[0].split('\n');
        return new GitBranch(repoPath, branch[0], true, data[1], branch[1]);
    }

    async getBranches(repoPath: string | undefined): Promise<GitBranch[]> {
        if (repoPath === undefined) return [];

        Logger.log(`getBranches('${repoPath}')`);

        const data = await Git.branch(repoPath, { all: true });
        // If we don't get any data, assume the repo doesn't have any commits yet so check if we have a current branch
        if (data === '') {
            const current = await this.getBranch(repoPath);
            return current !== undefined ? [current] : [];
        }

        return GitBranchParser.parse(data, repoPath) || [];
    }

    async getChangedFilesCount(repoPath: string, ref?: string): Promise<GitDiffShortStat | undefined> {
        Logger.log(`getChangedFilesCount('${repoPath}', '${ref}')`);

        const data = await Git.diff_shortstat(repoPath, ref);
        return GitDiffParser.parseShortStat(data);
    }

    async getConfig(key: string, repoPath?: string): Promise<string | undefined> {
        Logger.log(`getConfig('${key}', '${repoPath}')`);

        return await Git.config_get(key, repoPath);
    }

    private _userMapCache = new Map<string, { name?: string; email?: string } | null>();

    async getCurrentUser(repoPath: string) {
        let user = this._userMapCache.get(repoPath);
        if (user != null) return user;
        // If we found the repo, but no user data was found just return
        if (user === null) return undefined;

        const data = await Git.config_getRegex('user.(name|email)', repoPath);
        if (!data) {
            // If we found no user data, mark it so we won't bother trying again
            this._userMapCache.set(repoPath, null);
            return undefined;
        }

        user = { name: undefined, email: undefined };

        let match: RegExpExecArray | null = null;
        do {
            match = userConfigRegex.exec(data);
            if (match == null) break;

            // Stops excessive memory usage -- https://bugs.chromium.org/p/v8/issues/detail?id=2869
            user[match[1] as 'name' | 'email'] = (' ' + match[2]).substr(1);
        } while (match != null);

        const author = `${user.name} <${user.email}>`;
        // Check if there is a mailmap for the current user
        const mappedAuthor = await Git.check_mailmap(repoPath, author);
        if (author !== mappedAuthor) {
            match = mappedAuthorRegex.exec(mappedAuthor);
            if (match != null) {
                [, user.name, user.email] = match;
            }
        }

        this._userMapCache.set(repoPath, user);
        return user;
    }

    async getDiffForFile(uri: GitUri, ref1?: string, ref2?: string): Promise<GitDiff | undefined> {
        if (ref1 !== undefined && ref2 === undefined && uri.sha !== undefined) {
            ref2 = uri.sha;
        }

        let key = 'diff';
        if (ref1 !== undefined) {
            key += `:${ref1}`;
        }
        if (ref2 !== undefined) {
            key += `:${ref2}`;
        }

        const doc = await Container.tracker.getOrAdd(uri);
        if (this.UseCaching) {
            if (doc.state !== undefined) {
                const cachedDiff = doc.state.get<CachedDiff>(key);
                if (cachedDiff !== undefined) {
                    Logger.log(
                        `getDiffForFile[Cached(${key})]('${uri.repoPath}', '${uri.fsPath}', '${ref1}', '${ref2}')`
                    );
                    return cachedDiff.item;
                }
            }

            Logger.log(`getDiffForFile[Not Cached(${key})]('${uri.repoPath}', '${uri.fsPath}', '${ref1}', '${ref2}')`);

            if (doc.state === undefined) {
                doc.state = new GitDocumentState(doc.key);
            }
        }
        else {
            Logger.log(`getDiffForFile('${uri.repoPath}', '${uri.fsPath}', '${ref1}', '${ref2}')`);
        }

        const promise = this.getDiffForFileCore(
            uri.repoPath,
            uri.fsPath,
            ref1,
            ref2,
            { encoding: GitService.getEncoding(uri) },
            doc,
            key
        );

        if (doc.state !== undefined) {
            Logger.log(`Add log cache for '${doc.state.key}:${key}'`);

            doc.state.set<CachedDiff>(key, {
                item: promise
            } as CachedDiff);
        }

        return promise;
    }

    private async getDiffForFileCore(
        repoPath: string | undefined,
        fileName: string,
        ref1: string | undefined,
        ref2: string | undefined,
        options: { encoding?: string },
        document: TrackedDocument<GitDocumentState>,
        key: string
    ): Promise<GitDiff | undefined> {
        const [file, root] = Git.splitPath(fileName, repoPath, false);

        try {
            const data = await Git.diff(root, file, ref1, ref2, options);
            const diff = GitDiffParser.parse(data);
            return diff;
        }
        catch (ex) {
            // Trap and cache expected diff errors
            if (document.state !== undefined) {
                const msg = ex && ex.toString();
                Logger.log(`Replace diff cache with empty promise for '${document.state.key}:${key}'`);

                document.state.set<CachedDiff>(key, {
                    item: GitService.emptyPromise,
                    errorMessage: msg
                } as CachedDiff);

                return GitService.emptyPromise as Promise<GitDiff>;
            }

            return undefined;
        }
    }

    async getDiffForLine(
        uri: GitUri,
        line: number,
        ref1?: string,
        ref2?: string
    ): Promise<GitDiffChunkLine | undefined> {
        Logger.log(`getDiffForLine('${uri.repoPath}', '${uri.fsPath}', ${line}, '${ref1}', '${ref2}')`);

        try {
            const diff = await this.getDiffForFile(uri, ref1, ref2);
            if (diff === undefined) return undefined;

            const chunk = diff.chunks.find(c => c.currentPosition.start <= line && c.currentPosition.end >= line);
            if (chunk === undefined) return undefined;

            return chunk.lines[line - chunk.currentPosition.start + 1];
        }
        catch (ex) {
            return undefined;
        }
    }

    async getDiffStatus(
        repoPath: string,
        ref1?: string,
        ref2?: string,
        options: { filter?: string } = {}
    ): Promise<GitFile[] | undefined> {
        Logger.log(`getDiffStatus('${repoPath}', '${ref1}', '${ref2}', ${options.filter})`);

        try {
            const data = await Git.diff_nameStatus(repoPath, ref1, ref2, options);
            const diff = GitDiffParser.parseNameStatus(data, repoPath);
            return diff;
        }
        catch (ex) {
            return undefined;
        }
    }

    async getRecentLogCommitForFile(repoPath: string | undefined, fileName: string): Promise<GitLogCommit | undefined> {
        return this.getLogCommitForFile(repoPath, fileName, undefined);
    }

    async getRecentShaForFile(repoPath: string, fileName: string) {
        return await Git.log_recent(repoPath, fileName);
    }

    async getLogCommit(repoPath: string, ref: string): Promise<GitLogCommit | undefined> {
        Logger.log(`getLogCommit('${repoPath}', '${ref}'`);

        const log = await this.getLog(repoPath, { maxCount: 2, ref: ref });
        if (log === undefined) return undefined;

        return log.commits.get(ref);
    }

    async getLogCommitForFile(
        repoPath: string | undefined,
        fileName: string,
        options: { ref?: string; firstIfNotFound?: boolean; reverse?: boolean } = {}
    ): Promise<GitLogCommit | undefined> {
        Logger.log(
            `getFileLogCommit('${repoPath}', '${fileName}', '${options.ref}', ${options.firstIfNotFound}, ${
                options.reverse
            })`
        );

        const log = await this.getLogForFile(repoPath, fileName, {
            maxCount: 2,
            ref: options.ref,
            reverse: options.reverse
        });
        if (log === undefined) return undefined;

        const commit = options.ref && log.commits.get(options.ref);
        if (commit === undefined && !options.firstIfNotFound && options.ref) {
            // If the ref isn't a valid sha we will never find it, so let it fall through so we return the first
            if (!Git.isSha(options.ref) || Git.isUncommitted(options.ref)) return undefined;
        }

        return commit || Iterables.first(log.commits.values());
    }

    async getLog(
        repoPath: string,
        options: { author?: string; maxCount?: number; ref?: string; reverse?: boolean } = {}
    ): Promise<GitLog | undefined> {
        options = { reverse: false, ...options };

        Logger.log(`getLog('${repoPath}', '${options.ref}', ${options.maxCount}, ${options.reverse})`);

        const maxCount = options.maxCount == null ? Container.config.advanced.maxListItems || 0 : options.maxCount;

        try {
            const data = await Git.log(repoPath, {
                author: options.author,
                maxCount: maxCount,
                ref: options.ref,
                reverse: options.reverse
            });
            const log = GitLogParser.parse(
                data,
                GitCommitType.Branch,
                repoPath,
                undefined,
                options.ref,
                await this.getCurrentUser(repoPath),
                maxCount,
                options.reverse!,
                undefined
            );

            if (log !== undefined) {
                const opts = { ...options };
                log.query = (maxCount: number | undefined) => this.getLog(repoPath, { ...opts, maxCount: maxCount });
            }

            return log;
        }
        catch (ex) {
            return undefined;
        }
    }

    async getLogForSearch(
        repoPath: string,
        search: string,
        searchBy: GitRepoSearchBy,
        options: { maxCount?: number } = {}
    ): Promise<GitLog | undefined> {
        Logger.log(`getLogForSearch('${repoPath}', '${search}', '${searchBy}', ${options.maxCount})`);

        let maxCount = options.maxCount == null ? Container.config.advanced.maxListItems || 0 : options.maxCount;

        let searchArgs: string[] | undefined = undefined;
        switch (searchBy) {
            case GitRepoSearchBy.Author:
                searchArgs = ['-m', '-M', '--all', '--full-history', '-i', `--author=${search}`];
                break;
            case GitRepoSearchBy.ChangedLines:
                searchArgs = ['-M', '--all', '--full-history', '-i', `-G${search}`];
                break;
            case GitRepoSearchBy.Changes:
                searchArgs = ['-M', '--all', '--full-history', '-i', '--pickaxe-regex', `-S${search}`];
                break;
            case GitRepoSearchBy.Files:
                searchArgs = ['-M', '--all', '--full-history', '-i', `--`, `${search}`];
                break;
            case GitRepoSearchBy.Message:
                searchArgs = ['-m', '-M', '--all', '--full-history'];
                if (search) {
                    searchArgs.push(`--grep=${search}`);
                }
                break;
            case GitRepoSearchBy.Sha:
                searchArgs = [`-m`, '-M', search];
                maxCount = 1;
                break;
        }

        try {
            const data = await Git.log_search(repoPath, searchArgs, { maxCount: maxCount });
            const log = GitLogParser.parse(
                data,
                GitCommitType.Branch,
                repoPath,
                undefined,
                undefined,
                await this.getCurrentUser(repoPath),
                maxCount,
                false,
                undefined
            );

            if (log !== undefined) {
                const opts = { ...options };
                log.query = (maxCount: number | undefined) =>
                    this.getLogForSearch(repoPath, search, searchBy, { ...opts, maxCount: maxCount });
            }

            return log;
        }
        catch (ex) {
            return undefined;
        }
    }

    async getLogForFile(
        repoPath: string | undefined,
        fileName: string,
        options: { maxCount?: number; range?: Range; ref?: string; renames?: boolean; reverse?: boolean } = {}
    ): Promise<GitLog | undefined> {
        if (repoPath !== undefined && repoPath === Strings.normalizePath(fileName)) {
            throw new Error(`File name cannot match the repository path; fileName=${fileName}`);
        }

        options = { reverse: false, ...options };

        if (options.renames === undefined) {
            options.renames = Container.config.advanced.fileHistoryFollowsRenames;
        }

        let key = 'log';
        if (options.ref !== undefined) {
            key += `:${options.ref}`;
        }
        if (options.maxCount !== undefined) {
            key += `:n${options.maxCount}`;
        }
        if (options.renames) {
            key += `:follow`;
        }
        if (options.reverse) {
            key += `:reverse`;
        }

        const doc = await Container.tracker.getOrAdd(
            new GitUri(Uri.file(fileName), { repoPath: repoPath!, sha: options.ref })
        );
        if (this.UseCaching && options.range === undefined) {
            if (doc.state !== undefined) {
                const cachedLog = doc.state.get<CachedLog>(key);
                if (cachedLog !== undefined) {
                    Logger.log(
                        `getLogForFile[Cached(${key})]('${repoPath}', '${fileName}', '${options.ref}', ${
                            options.maxCount
                        }, undefined, ${options.renames}, ${options.reverse})`
                    );
                    return cachedLog.item;
                }

                if (options.ref !== undefined || options.maxCount !== undefined) {
                    // Since we are looking for partial log, see if we have the log of the whole file
                    const cachedLog = doc.state.get<CachedLog>(
                        `log${options.renames ? ':follow' : ''}${options.reverse ? ':reverse' : ''}`
                    );
                    if (cachedLog !== undefined) {
                        if (options.ref === undefined) {
                            Logger.log(
                                `getLogForFile[Cached(~${key})]('${repoPath}', '${fileName}', '', ${
                                    options.maxCount
                                }, undefined, ${options.renames}, ${options.reverse})`
                            );
                            return cachedLog.item;
                        }

                        Logger.log(
                            `getLogForFile[? Cache(${key})]('${repoPath}', '${fileName}', '${options.ref}', ${
                                options.maxCount
                            }, undefined, ${options.renames}, ${options.reverse})`
                        );
                        const log = await cachedLog.item;
                        if (log !== undefined && log.commits.has(options.ref)) {
                            Logger.log(
                                `getLogForFile[Cached(${key})]('${repoPath}', '${fileName}', '${options.ref}', ${
                                    options.maxCount
                                }, undefined, ${options.renames}, ${options.reverse})`
                            );
                            return cachedLog.item;
                        }
                    }
                }
            }

            Logger.log(
                `getLogForFile[Not Cached(${key})]('${repoPath}', '${fileName}', ${options.ref}, ${
                    options.maxCount
                }, undefined, ${options.reverse})`
            );

            if (doc.state === undefined) {
                doc.state = new GitDocumentState(doc.key);
            }
        }
        else {
            Logger.log(
                `getLogForFile('${repoPath}', '${fileName}', ${options.ref}, ${options.maxCount}, ${options.range &&
                    `[${options.range.start.line}, ${options.range.end.line}]`}, ${options.reverse})`
            );
        }

        const promise = this.getLogForFileCore(repoPath, fileName, options, doc, key);

        if (doc.state !== undefined && options.range === undefined) {
            Logger.log(`Add log cache for '${doc.state.key}:${key}'`);

            doc.state.set<CachedLog>(key, {
                item: promise
            } as CachedLog);
        }

        return promise;
    }

    private async getLogForFileCore(
        repoPath: string | undefined,
        fileName: string,
        options: { maxCount?: number; range?: Range; ref?: string; renames?: boolean; reverse?: boolean },
        document: TrackedDocument<GitDocumentState>,
        key: string
    ): Promise<GitLog | undefined> {
        if (!(await this.isTracked(fileName, repoPath, { ref: options.ref }))) {
            Logger.log(`Skipping log; '${fileName}' is not tracked`);
            return GitService.emptyPromise as Promise<GitLog>;
        }

        const [file, root] = Git.splitPath(fileName, repoPath, false);

        try {
            const { range, ...opts } = options;

            const maxCount = options.maxCount == null ? Container.config.advanced.maxListItems || 0 : options.maxCount;

            const data = await Git.log_file(root, file, {
                ...opts,
                maxCount: maxCount,
                startLine: range && range.start.line + 1,
                endLine: range && range.end.line + 1
            });
            const log = GitLogParser.parse(
                data,
                GitCommitType.File,
                root,
                file,
                opts.ref,
                await this.getCurrentUser(root),
                maxCount,
                opts.reverse!,
                range
            );

            if (log !== undefined) {
                const opts = { ...options };
                log.query = (maxCount: number | undefined) =>
                    this.getLogForFile(repoPath, fileName, { ...opts, maxCount: maxCount });
            }

            return log;
        }
        catch (ex) {
            // Trap and cache expected log errors
            if (document.state !== undefined && options.range === undefined && !options.reverse) {
                const msg = ex && ex.toString();
                Logger.log(`Replace log cache with empty promise for '${document.state.key}:${key}'`);

                document.state.set<CachedLog>(key, {
                    item: GitService.emptyPromise,
                    errorMessage: msg
                } as CachedLog);

                return GitService.emptyPromise as Promise<GitLog>;
            }

            return undefined;
        }
    }

    async hasRemotes(repoPath: string | undefined): Promise<boolean> {
        if (repoPath === undefined) return false;

        const repository = await this.getRepository(repoPath);
        if (repository === undefined) return false;

        return repository.hasRemotes();
    }

    async hasTrackingBranch(repoPath: string | undefined): Promise<boolean> {
        if (repoPath === undefined) return false;

        const repository = await this.getRepository(repoPath);
        if (repository === undefined) return false;

        return repository.hasTrackingBranch();
    }

    async getMergeBase(repoPath: string, ref1: string, ref2: string, options: { forkPoint?: boolean } = {}) {
        try {
            const data = await Git.merge_base(repoPath, ref1, ref2, options);
            if (data === undefined) return undefined;

            return data.split('\n')[0];
        }
        catch (ex) {
            Logger.error(ex, 'GitService.getMergeBase');
            return undefined;
        }
    }

    async getRemotes(repoPath: string | undefined, options: { includeAll?: boolean } = {}): Promise<GitRemote[]> {
        if (repoPath === undefined) return [];

        Logger.log(`getRemotes('${repoPath}')`);

        const repository = await this.getRepository(repoPath);
        const remotes = repository !== undefined ? repository.getRemotes() : this.getRemotesCore(repoPath);

        if (options.includeAll) return remotes;

        return (await remotes).filter(r => r.provider !== undefined);
    }

    async getRemotesCore(repoPath: string | undefined, providerMap?: RemoteProviderMap): Promise<GitRemote[]> {
        if (repoPath === undefined) return [];

        Logger.log(`getRemotesCore('${repoPath}')`);

        providerMap =
            providerMap ||
            RemoteProviderFactory.createMap(
                configuration.get<RemotesConfig[] | null | undefined>(configuration.name('remotes').value, null)
            );

        try {
            const data = await Git.remote(repoPath);
            return GitRemoteParser.parse(data, repoPath, RemoteProviderFactory.factory(providerMap));
        }
        catch (ex) {
            Logger.error(ex, 'GitService.getRemotesCore');
            return [];
        }
    }

    async getRepoPath(filePath: string, options?: { ref?: string }): Promise<string | undefined>;
    async getRepoPath(uri: Uri | undefined, options?: { ref?: string }): Promise<string | undefined>;
    async getRepoPath(
        filePathOrUri: string | Uri | undefined,
        options: { ref?: string } = {}
    ): Promise<string | undefined> {
        if (filePathOrUri == null) return await this.getActiveRepoPath();
        if (filePathOrUri instanceof GitUri) return filePathOrUri.repoPath;

        // Don't save the tracking info to the cache, because we could be looking in the wrong place (e.g. looking in the root when the file is in a submodule)
        let repo = await this.getRepository(filePathOrUri, { ...options, skipCacheUpdate: true });
        if (repo !== undefined) return repo.path;

        const rp = await this.getRepoPathCore(
            typeof filePathOrUri === 'string' ? filePathOrUri : filePathOrUri.fsPath,
            false
        );
        if (rp === undefined) return undefined;

        // Recheck this._repositoryTree.get(rp) to make sure we haven't already tried adding this due to awaits
        if (this._repositoryTree.get(rp) !== undefined) return rp;

        // If this new repo is inside one of our known roots and we we don't already know about, add it
        const root = this._repositoryTree.findSubstr(rp);
        let folder = root === undefined ? workspace.getWorkspaceFolder(Uri.file(rp)) : root.folder;

        if (folder === undefined) {
            const parts = rp.split('/');
            folder = { uri: Uri.file(rp), name: parts[parts.length - 1], index: this._repositoryTree.count() };
        }

        Logger.log(`Repository found in '${rp}'`);
        repo = new Repository(folder, rp, false, this.onAnyRepositoryChanged.bind(this), this._suspended);
        this._repositoryTree.set(rp, repo);

        // Send a notification that the repositories changed
        setImmediate(async () => {
            await this.updateContext(this._repositoryTree);

            this.fireRepositoriesChanged();
        });

        return rp;
    }

    private async getRepoPathCore(filePath: string, isDirectory: boolean): Promise<string | undefined> {
        try {
            return await Git.revparse_toplevel(isDirectory ? filePath : paths.dirname(filePath));
        }
        catch (ex) {
            Logger.error(ex, 'GitService.getRepoPathCore');
            return undefined;
        }
    }

    async getRepoPathOrActive(uri: Uri | undefined, editor: TextEditor | undefined) {
        const repoPath = await Container.git.getRepoPath(uri);
        if (repoPath) return repoPath;

        return Container.git.getActiveRepoPath(editor);
    }

    async getRepositories(predicate?: (repo: Repository) => boolean): Promise<Iterable<Repository>> {
        const repositoryTree = await this.getRepositoryTree();

        const values = repositoryTree.values();
        return predicate !== undefined ? Iterables.filter(values, predicate) : values;
    }

    private async getRepositoryTree(): Promise<TernarySearchTree<Repository>> {
        if (this._repositoriesLoadingPromise !== undefined) {
            await this._repositoriesLoadingPromise;
            this._repositoriesLoadingPromise = undefined;
        }

        return this._repositoryTree;
    }

    async getRepository(
        repoPath: string,
        options?: { ref?: string; skipCacheUpdate?: boolean }
    ): Promise<Repository | undefined>;
    async getRepository(
        uri: Uri,
        options?: { ref?: string; skipCacheUpdate?: boolean }
    ): Promise<Repository | undefined>;
    async getRepository(
        repoPathOrUri: string | Uri,
        options?: { ref?: string; skipCacheUpdate?: boolean }
    ): Promise<Repository | undefined>;
    async getRepository(
        repoPathOrUri: string | Uri,
        options: { ref?: string; skipCacheUpdate?: boolean } = {}
    ): Promise<Repository | undefined> {
        const repositoryTree = await this.getRepositoryTree();

        let path: string;
        if (typeof repoPathOrUri === 'string') {
            const repo = repositoryTree.get(repoPathOrUri);
            if (repo !== undefined) return repo;

            path = repoPathOrUri;
        }
        else {
            if (repoPathOrUri instanceof GitUri) {
                if (repoPathOrUri.repoPath) {
                    const repo = repositoryTree.get(repoPathOrUri.repoPath);
                    if (repo !== undefined) return repo;
                }

                path = repoPathOrUri.fsPath;
            }
            else {
                path = repoPathOrUri.fsPath;
            }
        }

        const repo = repositoryTree.findSubstr(path);
        if (repo === undefined) return undefined;

        // Make sure the file is tracked in this repo before returning -- it could be from a submodule
        if (!(await this.isTracked(path, repo.path, options))) return undefined;
        return repo;
    }

    async getRepositoryCount(): Promise<number> {
        const repositoryTree = await this.getRepositoryTree();
        return repositoryTree.count();
    }

    async getStashList(repoPath: string | undefined): Promise<GitStash | undefined> {
        if (repoPath === undefined) return undefined;

        Logger.log(`getStashList('${repoPath}')`);

        const data = await Git.stash_list(repoPath);
        const stash = GitStashParser.parse(data, repoPath);
        return stash;
    }

    async getStatusForFile(repoPath: string, fileName: string): Promise<GitStatusFile | undefined> {
        Logger.log(`getStatusForFile('${repoPath}', '${fileName}')`);

        const porcelainVersion = Git.validateVersion(2, 11) ? 2 : 1;

        const data = await Git.status_file(repoPath, fileName, porcelainVersion);
        const status = GitStatusParser.parse(data, repoPath, porcelainVersion);
        if (status === undefined || !status.files.length) return undefined;

        return status.files[0];
    }

    async getStatusForRepo(repoPath: string | undefined): Promise<GitStatus | undefined> {
        if (repoPath === undefined) return undefined;

        Logger.log(`getStatusForRepo('${repoPath}')`);

        const porcelainVersion = Git.validateVersion(2, 11) ? 2 : 1;

        const data = await Git.status(repoPath, porcelainVersion);
        const status = GitStatusParser.parse(data, repoPath, porcelainVersion);
        return status;
    }

    async getTags(repoPath: string | undefined): Promise<GitTag[]> {
        if (repoPath === undefined) return [];

        Logger.log(`getTags('${repoPath}')`);

        const data = await Git.tag(repoPath);
        return GitTagParser.parse(data, repoPath) || [];
    }

    async getTreeFileForRevision(repoPath: string, fileName: string, ref: string): Promise<GitTree | undefined> {
        if (repoPath === undefined) return undefined;

        Logger.log(`getTreeFileForRevision('${repoPath}', '${fileName}', '${ref}')`);

        const data = await Git.ls_tree(repoPath, ref, { fileName: fileName });
        const trees = GitTreeParser.parse(data);
        return trees === undefined || trees.length === 0 ? undefined : trees[0];
    }

    async getTreeForRevision(repoPath: string, ref: string): Promise<GitTree[]> {
        if (repoPath === undefined) return [];

        Logger.log(`getTreeForRevision('${repoPath}', '${ref}')`);

        const data = await Git.ls_tree(repoPath, ref);
        return GitTreeParser.parse(data) || [];
    }

    async getVersionedFile(
        repoPath: string | undefined,
        fileName: string,
        ref: string | undefined
    ): Promise<Uri | undefined> {
        if (ref === GitService.deletedOrMissingSha) return undefined;

        Logger.log(`getVersionedFile('${repoPath}', '${fileName}', '${ref}')`);

        if (!ref || (Git.isUncommitted(ref) && !Git.isStagedUncommitted(ref))) {
            if (await this.fileExists(repoPath!, fileName)) return Uri.file(fileName);

            return undefined;
        }

        return GitUri.toRevisionUri(ref, fileName, repoPath!);
    }

    getVersionedFileBuffer(repoPath: string, fileName: string, ref: string) {
        Logger.log(`getVersionedFileBuffer('${repoPath}', '${fileName}', ${ref})`);

        return Git.show<Buffer>(repoPath, fileName, ref, { encoding: 'buffer' });
    }

    isTrackable(scheme: string): boolean;
    isTrackable(uri: Uri): boolean;
    isTrackable(schemeOruri: string | Uri): boolean {
        let scheme: string;
        if (typeof schemeOruri === 'string') {
            scheme = schemeOruri;
        }
        else {
            scheme = schemeOruri.scheme;
        }

        return scheme === DocumentSchemes.File || scheme === DocumentSchemes.Git || scheme === DocumentSchemes.GitLens;
    }

    async isTracked(
        fileName: string,
        repoPath?: string,
        options?: { ref?: string; skipCacheUpdate?: boolean }
    ): Promise<boolean>;
    async isTracked(uri: GitUri): Promise<boolean>;
    async isTracked(
        fileNameOrUri: string | GitUri,
        repoPath?: string,
        options: { ref?: string; skipCacheUpdate?: boolean } = {}
    ): Promise<boolean> {
        if (options.ref === GitService.deletedOrMissingSha) return false;

        let ref = options.ref;
        let cacheKey: string;
        let fileName: string;
        if (typeof fileNameOrUri === 'string') {
            [fileName, repoPath] = Git.splitPath(fileNameOrUri, repoPath);
            cacheKey = GitUri.toKey(fileNameOrUri);
        }
        else {
            if (!this.isTrackable(fileNameOrUri)) return false;

            fileName = fileNameOrUri.fsPath;
            repoPath = fileNameOrUri.repoPath;
            ref = fileNameOrUri.sha;
            cacheKey = GitUri.toKey(fileName);
        }

        if (ref !== undefined) {
            cacheKey += `:${ref}`;
        }

        let tracked = this._trackedCache.get(cacheKey);
        try {
            if (tracked !== undefined) {
                tracked = await tracked;

                return tracked;
            }

            tracked = this.isTrackedCore(fileName, repoPath === undefined ? '' : repoPath, ref);
            if (options.skipCacheUpdate) {
                tracked = await tracked;

                return tracked;
            }

            this._trackedCache.set(cacheKey, tracked);
            tracked = await tracked;
            this._trackedCache.set(cacheKey, tracked);

            return tracked;
        }
        finally {
            Logger.log(`isTracked('${fileName}', '${repoPath}'${ref !== undefined ? `, '${ref}'` : ''}) = ${tracked}`);
        }
    }

    private async isTrackedCore(fileName: string, repoPath: string, ref?: string) {
        if (ref === GitService.deletedOrMissingSha) return false;

        try {
            // Even if we have a ref, check first to see if the file exists (that way the cache will be better reused)
            let tracked = !!(await Git.ls_files(repoPath === undefined ? '' : repoPath, fileName));
            if (!tracked && ref !== undefined) {
                tracked = !!(await Git.ls_files(repoPath === undefined ? '' : repoPath, fileName, { ref: ref }));
                // If we still haven't found this file, make sure it wasn't deleted in that ref (i.e. check the previous)
                if (!tracked) {
                    tracked = !!(await Git.ls_files(repoPath === undefined ? '' : repoPath, fileName, {
                        ref: `${ref}^`
                    }));
                }
            }
            return tracked;
        }
        catch (ex) {
            Logger.error(ex, 'GitService.isTrackedCore');
            return false;
        }
    }

    async getDiffTool(repoPath?: string) {
        return (await Git.config_get('diff.guitool', repoPath)) || (await Git.config_get('diff.tool', repoPath));
    }

    async openDiffTool(repoPath: string, uri: Uri, staged: boolean, tool?: string) {
        if (!tool) {
            tool = await this.getDiffTool(repoPath);
            if (tool === undefined) throw new Error('No diff tool found');
        }

        Logger.log(`openDiffTool('${repoPath}', '${uri.fsPath}', ${staged}, '${tool}')`);

        return Git.difftool_fileDiff(repoPath, uri.fsPath, tool, staged);
    }

    async openDirectoryDiff(repoPath: string, ref1: string, ref2?: string, tool?: string) {
        if (!tool) {
            tool = await this.getDiffTool(repoPath);
            if (tool === undefined) throw new Error('No diff tool found');
        }

        Logger.log(`openDirectoryDiff('${repoPath}', '${ref1}', '${ref2}', '${tool}')`);

        return Git.difftool_dirDiff(repoPath, tool, ref1, ref2);
    }

    async resolveReference(repoPath: string, ref: string, uri?: Uri) {
        if (Git.isSha(ref) || !Git.isShaLike(ref) || ref.endsWith('^3')) return ref;

        Logger.log(`resolveReference('${repoPath}', '${ref}', '${uri && uri.toString(true)}')`);

        if (uri == null) return (await Git.revparse(repoPath, ref)) || ref;

        const fileName = Strings.normalizePath(paths.relative(repoPath, uri.fsPath));
        const resolvedRef = await Git.log_resolve(repoPath, fileName, ref);

        const ensuredRef = await Git.cat_file_validate(repoPath, fileName, resolvedRef || ref);
        if (ensuredRef === undefined) return ref;

        return ensuredRef;
    }

    stopWatchingFileSystem() {
        this._repositoryTree.forEach(r => r.stopWatchingFileSystem());
    }

    stashApply(repoPath: string, stashName: string, deleteAfter: boolean = false) {
        Logger.log(`stashApply('${repoPath}', '${stashName}', ${deleteAfter})`);

        return Git.stash_apply(repoPath, stashName, deleteAfter);
    }

    stashDelete(repoPath: string, stashName: string) {
        Logger.log(`stashDelete('${repoPath}', '${stashName}')`);

        return Git.stash_delete(repoPath, stashName);
    }

    stashSave(repoPath: string, message?: string, uris?: Uri[]) {
        Logger.log(`stashSave('${repoPath}', '${message}', ${uris})`);

        if (uris === undefined) return Git.stash_save(repoPath, message);

        GitService.ensureGitVersion('2.13.2', 'Stashing individual files');

        const pathspecs = uris.map(u => Git.splitPath(u.fsPath, repoPath)[0]);
        return Git.stash_push(repoPath, pathspecs, message);
    }

    static getEncoding(repoPath: string, fileName: string): string;
    static getEncoding(uri: Uri): string;
    static getEncoding(repoPathOrUri: string | Uri, fileName?: string): string {
        const uri = typeof repoPathOrUri === 'string' ? Uri.file(paths.join(repoPathOrUri, fileName!)) : repoPathOrUri;
        return Git.getEncoding(workspace.getConfiguration('files', uri).get<string>('encoding'));
    }

    static async initialize(): Promise<void> {
        // Try to use the same git as the built-in vscode git extension
        let gitPath;
        try {
            const gitExtension = extensions.getExtension('vscode.git');
            if (gitExtension !== undefined) {
                const gitApi = ((gitExtension.isActive
                    ? gitExtension.exports
                    : await gitExtension.activate()) as GitExtension).getAPI(1);
                gitPath = gitApi.git.path;
            }
        }
        catch {}

        await Git.setOrFindGitPath(gitPath || workspace.getConfiguration('git').get<string>('path'));
    }

    static getGitPath(): string {
        return Git.getGitPath();
    }

    static getGitVersion(): string {
        return Git.getGitVersion();
    }

    static isShaLike(ref: string): boolean {
        return Git.isShaLike(ref);
    }

    static isStagedUncommitted(ref: string | undefined): boolean {
        return Git.isStagedUncommitted(ref);
    }

    static isUncommitted(ref: string | undefined): boolean {
        return Git.isUncommitted(ref);
    }

    static shortenSha(
        ref: string | undefined,
        strings: { deletedOrMissing?: string; stagedUncommitted?: string; uncommitted?: string; working?: string } = {}
    ) {
        if (ref === undefined) return undefined;

        strings = { deletedOrMissing: '(deleted)', working: '', ...strings };

        if (ref === '') return strings.working;
        if (ref === GitService.deletedOrMissingSha) return strings.deletedOrMissing;

        return Git.isShaLike(ref) || Git.isStagedUncommitted(ref) ? Git.shortenSha(ref, strings) : ref;
    }

    static compareGitVersion(version: string, throwIfLessThan?: Error) {
        return Versions.compare(Versions.fromString(this.getGitVersion()), Versions.fromString(version));
    }

    static ensureGitVersion(version: string, feature: string): void {
        const gitVersion = this.getGitVersion();
        if (Versions.compare(Versions.fromString(gitVersion), Versions.fromString(version)) === -1) {
            throw new Error(
                `${feature} requires a newer version of Git (>= ${version}) than is currently installed (${gitVersion}). Please install a more recent version of Git to use this GitLens feature.`
            );
        }
    }
}
