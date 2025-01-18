import { commands, env, ThemeIcon, TreeItem, TreeItemCollapsibleState, TreeView, window, workspace } from "vscode";

import { TreeProvider } from "./tree-provider";
import { ConfigMaid } from "./utils/config-maid";
import { Janitor } from "./utils/janitor";
import { Aux } from "./utils/auxiliary";
import { TreeItems } from "./tree-items";

/**
 * Provides Git Branches view on primary sidebar, main presentation module
 */
export namespace BranchesTreeView {
	const provider = new TreeProvider.Provider();
	const view: TreeView<TreeItems.BranchItem | TreeItem> = window.createTreeView("git-branches.gitBranches", {
		treeDataProvider: provider,
		canSelectMany: false,
	});

	let foldState: 0 | 1 | 2 = <0 | 1 | 2>(
		(Number(provider.expandBranches) + Number(provider.expandBranches && provider.expandUnmergedDetails))
	);

	/**
	 * Inits Git Branches provider, view and event listeners
	 */
	export async function init(): Promise<void> {
		ConfigMaid.onChange("git-branches", () => provider.reload());
		ConfigMaid.onChange(
			["git-branches.expandBranchesByDefault", "git-branches.expandUnmergedDetailsByDefault"],
			(level1, level2) => {
				updateExpandState(level1, level2);
				foldState = Number(level1) + Number(level1 && level2);
			},
		);

		ConfigMaid.schedule(() => provider.reload(), "git-branches.fetchDelay");

		Janitor.add(
			view,

			commands.registerCommand("git-branches.switchRepo", switchRepo),
			commands.registerCommand("git-branches.reloadView", () => provider.reload()),
			commands.registerCommand("git-branches.toggleViewFold", toggleViewFold),
			commands.registerCommand("git-branches.toggleRemoteBranches", () => {
				const enablement = !ConfigMaid.get("git-branches.includeRemotes");
				workspace.getConfiguration("git-branches").update("includeRemotes", enablement);
			}),

			commands.registerCommand("git-branches.copyBranchName", (branchItem: TreeItems.BranchItem) =>
				env.clipboard.writeText(branchItem.branch.id),
			),
			commands.registerCommand("git-branches.copyCommitHash", (commitItem: TreeItems.CommitItem) =>
				env.clipboard.writeText(commitItem.hash),
			),
			commands.registerCommand("git-branches.switchToBranch", (branchItem: TreeItems.BranchItem) =>
				provider.gitRunner.switchToBranch(branchItem.branch),
			),
		);

		await provider.init();
		if (!provider.enabled) return;

		view.title = provider.currRepo.rootUri.path.split("/").at(-1);
	}

	async function switchRepo(): Promise<void> {
		if (!provider.enabled) return;
		const otherRepos = provider.gitExtensionAPI.repositories.filter(
			(repo) => repo.rootUri.fsPath !== provider.currRepo.rootUri.fsPath,
		);

		const repoIcon = new ThemeIcon("repo");
		const pick = await window.showQuickPick(
			otherRepos.map((repo) => ({
				label: repo.rootUri.path.split("/").at(-1),
				description: Aux.string.capital(repo.rootUri.fsPath),
				iconPath: repoIcon,
				repo,
			})),
		);
		if (!pick) return;

		view.title = pick.label;
		await provider.reload(pick.repo);
	}

	/**
	 * Updates primary & secondary item's expand/collapse state
	 */
	async function updateExpandState(level1: boolean, level2: boolean): Promise<void> {
		try {
			await view.reveal(provider.items[0], { focus: true });
			await commands.executeCommand("list.collapseAll");
			for (const item of provider.items) {
				if (item.collapsibleState === TreeItemCollapsibleState.None) continue;
				await view.reveal(item, { focus: true, select: false, expand: level2 ? 2 : false });
				await commands.executeCommand(level1 ? "list.expand" : "list.collapse");
			}
			await view.reveal(provider.items[0], { focus: true });
		} catch {}
	}

	/**
	 * Toggles view fold state: Layer1, Layer2, Collapsed
	 */
	async function toggleViewFold(): Promise<void> {
		foldState =
			(foldState + 1) %
			(provider.items.some((item) => (item instanceof TreeItems.BranchItem ? !item.fullyMerged : false)) ? 3 : 2);
		await updateExpandState(foldState > 0, foldState > 1);
	}
}
