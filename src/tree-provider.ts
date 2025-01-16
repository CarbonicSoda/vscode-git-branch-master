import {
	Event,
	EventEmitter,
	extensions,
	MarkdownString,
	ThemeIcon,
	TreeDataProvider,
	TreeItem,
	TreeItemCollapsibleState,
} from "vscode";
import { API as GitAPI, GitExtension, Repository } from "./declarations/git";

import { Aux } from "./utils/auxiliary";
import { ConfigMaid } from "./utils/config-maid";
import { Janitor } from "./utils/janitor";
import { VSColors } from "./utils/vs-colors";

import { Branch, GitRunner } from "./git-runner";

export namespace BranchesTreeProvider {
	//#region CONSTANTS
	export const VSCODE_GIT_API_VERSION = 1;

	export const TIMEOUT_GET_REPO = 10;

	export const SEPARATOR_ITEM = new TreeItem("", TreeItemCollapsibleState.None);
	//#endregion CONSTANTS

	/**
	 * Tree item class for a git branch
	 */
	export class BranchItem extends TreeItem {
		children: (BranchItem | TreeItem)[] = [];

		type: "local" | "remote";
		latestHash: string;
		mergeBaseHash: string;
		branchDiff: {
			from: string[];
			fromCnt: number;
			to: string[];
			toCnt: number;
			sym: string[];
			symCnt: number;
		};

		constructor(public branch: Branch, expand: "expand" | "collapse" | "none", public parent?: BranchItem) {
			const state = {
				expand: TreeItemCollapsibleState.Expanded,
				collapse: TreeItemCollapsibleState.Collapsed,
				none: TreeItemCollapsibleState.None,
			}[expand];
			super(branch.id, state);
			this.type = branch.type;
		}
	}

	/**
	 * Git Branches tree data provider
	 */
	export class Provider implements TreeDataProvider<BranchItem | TreeItem> {
		items: (BranchItem | TreeItem)[] = [];

		treeDataChangeEmitter: EventEmitter<void | undefined | BranchItem> = new EventEmitter<
			void | undefined | BranchItem
		>();
		onDidChangeTreeData: Event<void | undefined | BranchItem> = this.treeDataChangeEmitter.event;

		gitExtension: GitExtension;

		gitExtensionAPI?: GitAPI;
		gitPath?: string;
		gitRunner?: GitRunner;

		currRepo?: Repository;
		repoListener?: Janitor.Id;

		get enabled(): boolean {
			return this.gitEnabled && this.currRepo !== undefined;
		}
		get gitEnabled(): boolean {
			return ConfigMaid.get("git.enabled");
		}

		async initProvider(): Promise<void> {
			this.gitExtension = await extensions.getExtension<GitExtension>("vscode.git").activate();

			ConfigMaid.onChange("git", () => {
				Janitor.clear(this.repoListener);
				if (this.gitEnabled) this.refreshGitAPI();
				else {
					this.items = [];
					this.refresh();
					this.gitExtensionAPI = this.gitPath = this.gitRunner = this.currRepo = undefined;
				}
			});

			if (this.gitEnabled) await this.refreshGitAPI();
		}

		async refreshGitAPI(): Promise<void> {
			if (!this.gitExtension.enabled) {
				await new Promise<void>((res) => {
					const once = this.gitExtension.onDidChangeEnablement(() => {
						once.dispose();
						res();
					});
				});
			}
			this.gitExtensionAPI = this.gitExtension.getAPI(VSCODE_GIT_API_VERSION);
			this.gitPath = this.gitExtensionAPI.git.path;

			this.repoListener = Janitor.add(
				this.gitExtensionAPI.onDidOpenRepository((repo) => {
					if (this.currRepo) return;
					this.currRepo = repo;
					this.refreshGitRunner();
				}),
			);
			this.currRepo = await this.getPrimaryRepo();
			if (this.currRepo) await this.refreshGitRunner();
		}

		async refreshGitRunner(): Promise<void> {
			this.gitRunner = new GitRunner(this.gitPath, this.currRepo.rootUri.fsPath);
			await this.reloadItems();
		}

		/**
		 * Resolves to undefined after {@link TIMEOUT_GET_REPO} seconds if primary repo cant be found
		 * @returns Primary repository of workspace or null if not found
		 */
		async getPrimaryRepo(): Promise<Repository | undefined> {
			return await new Promise((res) => {
				const repo = this.gitExtensionAPI.repositories[0];
				if (repo) return res(repo);

				const once = this.gitExtensionAPI.onDidOpenRepository((repo) => {
					clearTimeout(timeout);
					once.dispose();
					res(repo);
				});
				const timeout = setTimeout(() => {
					once.dispose();
					res(undefined);
				}, TIMEOUT_GET_REPO * 1000);
			});
		}

		//#region Interface implementation methods

		getTreeItem(element: BranchItem): BranchItem {
			return element;
		}

		getParent(element: BranchItem): undefined | BranchItem {
			return element.parent;
		}

		getChildren(element: BranchItem | undefined): (BranchItem | TreeItem)[] {
			if (element) return element.children;
			return this.items;
		}

		//#endregion End of interface implementation methods

		/**
		 * Updates provider items (does not reload items)
		 * @param item item to be updated, if not given the whole tree is refreshed
		 */
		refresh(item?: BranchItem): void {
			this.treeDataChangeEmitter.fire(item);
		}

		/**
		 * Reloads provider with updated items
		 */
		async reloadItems(): Promise<void> {
			if (!this.enabled) return;
			this.items = await this.getItems();
			this.treeDataChangeEmitter.fire();
		}

		/**
		 * Retrieves updates and builds view items
		 * @returns built items (primary-hierarchy)
		 */
		private async getItems(): Promise<(BranchItem | TreeItem)[]> {
			//#region CONFIGS
			//MO TODO add method to set configs to override default
			const defIncludeRemotes = <boolean>ConfigMaid.get("git-branches.view.includeRemotesByDefault");
			const defExpandBranches = <boolean>ConfigMaid.get("git-branches.view.expandBranchesByDefault");
			const defExpandUnmergedDetails = <boolean>(
				ConfigMaid.get("git-branches.view.expandUnmergedDetailsByDefault")
			);
			const defBranchSort = <"Commit Date" | "Alphabetic">(
				ConfigMaid.get("git-branches.view.defaultBranchesSortMethod")
			);
			const pinnedBranches = <string[]>ConfigMaid.get("git-branches.view.pinnedBranches");
			//#endregion CONFIGS

			//#region COLORS
			const PINNED_COLOR = VSColors.interpolate("#FF0");
			const MERGED_COLOR = VSColors.interpolate("#0F0");
			const UNMERGED_COLOR = VSColors.interpolate("#F00");
			//#endregion COLORS

			const branches = await this.gitRunner.getBranches(defIncludeRemotes ? "all" : "local", {
				sort: defBranchSort,
			});
			const itemsState = branches.length === 1 ? "none" : defExpandBranches ? "expand" : "collapse";

			let localItems: BranchItem[] = [];
			let remoteItems: BranchItem[] = [];
			await Aux.async.map(branches, async (branch, i) => {
				const item = new BranchItem(branch, itemsState);

				const isPinned = pinnedBranches.includes(branch.name);
				const iconId =
					branch.type === "local"
						? isPinned
							? "repo"
							: "git-branch"
						: isPinned
						? "github-inverted"
						: "github-alt";
				item.iconPath = new ThemeIcon(iconId, isPinned ? PINNED_COLOR : VSColors.hash(branch.id));

				try {
					item.latestHash = await this.gitRunner.getLatestHash(branch, { short: true });
				} catch {
					return;
				}

				const lastUpdated = await this.gitRunner.getUpdatedTime(branch, "local");
				item.tooltip = new MarkdownString(
					`$(${iconId}) ${Aux.string.capital(branch.type)} - _${branch.id}_  \nLatest Commit __${
						item.latestHash
					}__  \nUpdated ${lastUpdated}`,
				);

				(branch.type === "local" ? localItems : remoteItems)[i] = item;
			});

			pinnedBranches.reverse();
			[localItems, remoteItems] = [localItems, remoteItems].map((items) => {
				return items.flat().sort((a, b) => {
					return pinnedBranches.indexOf(b.branch.name) - pinnedBranches.indexOf(a.branch.name);
				});
			});

			const items: BranchItem[] = localItems.concat(remoteItems);
			await Aux.async.map(items, async (self, i) => {
				const selfBranch = self.branch;

				let mergedItems: BranchItem[] = [];
				let unmergedItems: BranchItem[] = [];
				await Aux.async.map(items, async (other, j) => {
					if (i === j) return;
					const otherBranch = other.branch;

					const child = new BranchItem(otherBranch, "none", self);

					child.latestHash = items[j].latestHash;
					child.branchDiff = await this.gitRunner.getBranchDiff(otherBranch, selfBranch, { short: true });
					const isMerged = child.branchDiff.fromCnt === 0;
					child.mergeBaseHash = isMerged
						? other.latestHash
						: await this.gitRunner.getMergeBaseHash(otherBranch, selfBranch, { short: true });

					child.description = `${Aux.string.capital(otherBranch.type)} - ${
						isMerged ? `Merged` : "↓" + child.branchDiff.fromCnt
					} ↑${child.branchDiff.toCnt}`;
					child.tooltip = new MarkdownString(
						`${(<MarkdownString>other.tooltip).value}\n\n${
							isMerged ? `Fully Merged` : "From $(arrow-down) " + child.branchDiff.fromCnt
						} __-__ To $(arrow-up) ${child.branchDiff.toCnt} ${
							isMerged ? "" : " __-__ Sym $(arrow-swap) " + child.branchDiff.symCnt
						}  \nMerge Base __${child.mergeBaseHash}__`,
						true,
					);
					child.iconPath = isMerged
						? new ThemeIcon("check", MERGED_COLOR)
						: new ThemeIcon("x", UNMERGED_COLOR);

					(isMerged ? mergedItems : unmergedItems)[j] = child;
				});
				mergedItems = mergedItems.flat();
				unmergedItems = unmergedItems.flat();

				await Aux.async.map(unmergedItems, async (item, j) => {
					const latestFromItem = new TreeItem({ label: item.latestHash, highlights: [[0, 7]] });
					latestFromItem.description = "^Latest";
					latestFromItem.tooltip = new MarkdownString(
						`Branch _${item.label}_\n\n\`\`\`\n* ${item.branchDiff.from.join("\n  ")}\n& ${
							item.mergeBaseHash
						}\n\`\`\``,
					);

					const spreadItem = new TreeItem("");
					spreadItem.description = `${item.branchDiff.fromCnt} Ahead Merge Base`;

					const mergeBaseItem = new TreeItem({ label: item.mergeBaseHash, highlights: [[0, 7]] });
					if (item.branchDiff.toCnt === 0) {
						mergeBaseItem.description = "Latest";
						mergeBaseItem.tooltip = "";
					} else {
						mergeBaseItem.description = `${item.branchDiff.toCnt} Commit${Aux.string.plural(
							item.branchDiff.toCnt,
						)} Ago`;
						mergeBaseItem.tooltip = new MarkdownString(
							`Branch _${item.parent.label}_\n\n\`\`\`\n* ${item.branchDiff.to.join("\n  ")}\n& ${
								item.mergeBaseHash
							}\n\`\`\``,
						);
					}

					item.collapsibleState = defExpandUnmergedDetails
						? TreeItemCollapsibleState.Expanded
						: TreeItemCollapsibleState.Collapsed;
					item.children = [
						latestFromItem,
						spreadItem,
						mergeBaseItem,
						...Aux.array.opt(j < unmergedItems.length - 1, SEPARATOR_ITEM),
					];
				});

				self.children = [].concat(
					mergedItems,
					...Aux.array.opt(mergedItems.length > 0 && unmergedItems.length > 0, SEPARATOR_ITEM),
					unmergedItems,
					...Aux.array.opt(i < items.length - 1, SEPARATOR_ITEM),
				);

				const fullyMerged = unmergedItems.length === 0;
				self.description =
					`${Aux.string.capital(selfBranch.type)} - ` +
					(fullyMerged ? "Fully Merged" : `\u2713${mergedItems.length} \u00d7${unmergedItems.length}`);
				self.tooltip = new MarkdownString(
					`${(<MarkdownString>self.tooltip).value}\n\n` +
						(fullyMerged
							? "Fully Merged"
							: `Merged $(check) ${mergedItems.length} __-__ Unmerged $(x) ${unmergedItems.length}`),
					true,
				);
			});

			return [].concat(
				localItems,
				...Aux.array.opt(localItems.length > 0 && remoteItems.length > 0, SEPARATOR_ITEM),
				remoteItems,
			);
		}
	}
}
