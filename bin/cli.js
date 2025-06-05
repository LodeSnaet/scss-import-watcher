#!/usr/bin/env node

const path = require("path");
const scssImportWatcher = require("../index");

async function main() {
  const args = process.argv.slice(2);

  const inquirerModule = await import("inquirer");
  const inquirer = inquirerModule.default;

  const watchers = [];

  function labelFromConfig(config) {
    const relWatchDir = path.relative(
      config.rootDir,
      path.resolve(config.rootDir, config.watchDir),
    );
    return `${relWatchDir} → ${config.stylesFile}`;
  }

  /**
   * Given current watchers list and a new watch folder,
   * find which existing watchers are children of this folder (nested watchers),
   * or parents of this folder.
   */
  function findNestedWatchers(watchFolderAbs) {
    const nested = [];
    for (const { config } of watchers) {
      const otherAbs = path.resolve(config.rootDir, config.watchDir);

      // if otherAbs is strictly inside watchFolderAbs
      if (
        otherAbs !== watchFolderAbs &&
        otherAbs.startsWith(watchFolderAbs + path.sep)
      ) {
        nested.push(otherAbs);
      }
    }
    return nested;
  }

  /**
   * Given current watchers list and a watchFolder, find watcher folder paths
   * that are parents of this folder (to exclude it from them).
   */
  function findParentWatchers(watchFolderAbs) {
    const parents = [];
    for (const { config } of watchers) {
      const otherAbs = path.resolve(config.rootDir, config.watchDir);

      // if watchFolderAbs is inside otherAbs (and not same)
      if (
        otherAbs !== watchFolderAbs &&
        watchFolderAbs.startsWith(otherAbs + path.sep)
      ) {
        parents.push(otherAbs);
      }
    }
    return parents;
  }

  /**
   * Update watchers so that:
   * - Parent watchers exclude their nested watchers paths
   * - New watcher excludes no paths (or can be extended)
   */
  function updateWatcherExclusions() {
    // Build a map: watcherAbs -> array of nested watcher absolute paths to exclude
    const excludeMap = new Map();

    for (const { config } of watchers) {
      const watcherAbs = path.resolve(config.rootDir, config.watchDir);
      // nested watchers inside this watcher
      const nested = watchers
        .map((w) => path.resolve(w.config.rootDir, w.config.watchDir))
        .filter((p) => p !== watcherAbs && p.startsWith(watcherAbs + path.sep));
      excludeMap.set(watcherAbs, nested);
    }

    // Recreate watchers with updated excludePaths
    // But since you cannot re-create watchers easily, just update each watcher instance's excludedPaths if you store it
    // In your current code, excludePaths are passed only on init, so we have to recreate watchers or patch the module

    // So as a workaround, we close all watchers and recreate them with updated excludePaths
    // This is safe because user adds watchers interactively rarely

    // Save configs and close all watchers
    for (const { instance } of watchers) {
      instance.close();
    }

    // Save configs
    const savedConfigs = watchers.map((w) => w.config);

    // Clear watchers array
    watchers.length = 0;

    // Recreate watchers with updated excludePaths
    for (const config of savedConfigs) {
      const watcherAbs = path.resolve(config.rootDir, config.watchDir);
      const excludePaths = excludeMap.get(watcherAbs) || [];
      const instance = scssImportWatcher({
        rootDir: config.rootDir,
        watchDir: config.watchDir,
        stylesFile: config.stylesFile,
        label: labelFromConfig(config),
        excludePaths,
      });
      watchers.push({ config, instance });
    }
  }

  async function promptForWatcher() {
    const answers = await inquirer.prompt([
      {
        type: "input",
        name: "watchDir",
        message: "Enter the folder to watch for SCSS files:",
        default: "src/scss/components",
      },
      {
        type: "input",
        name: "stylesFile",
        message: "Enter the SCSS file path to update with imports:",
        default: "src/scss/styles.scss",
      },
      {
        type: "input",
        name: "rootDir",
        message: "Enter the root directory (leave empty for current):",
        default: process.cwd(),
      },
    ]);

    let stylesFile = answers.stylesFile.trim();
    if (!stylesFile.toLowerCase().endsWith(".scss")) {
      stylesFile += ".scss";
    }

    const rootDir = path.resolve(answers.rootDir.trim() || process.cwd());
    const watchDir = answers.watchDir.trim();
    const resolvedStylesFile = path.relative(
      rootDir,
      path.resolve(rootDir, stylesFile),
    );

    console.log("\n✅ Watcher configured:");
    console.log(`   📁 Watch folder: ${watchDir}`);
    console.log(`   📄 Styles file:  ${resolvedStylesFile}`);
    console.log(`   📂 Root:         ${rootDir}\n`);

    try {
      const instance = scssImportWatcher({
        rootDir,
        watchDir,
        stylesFile: resolvedStylesFile,
        label: labelFromConfig({
          rootDir,
          watchDir,
          stylesFile: resolvedStylesFile,
        }),
        excludePaths: [], // initially empty, will fix after adding to watchers
      });

      watchers.push({
        config: { rootDir, watchDir, stylesFile: resolvedStylesFile },
        instance,
      });

      // After adding watcher, update all watchers' excludePaths
      updateWatcherExclusions();

      console.log("🎉 Watcher is now running!");
    } catch (err) {
      console.error("❌ Failed to start watcher:", err.message);
    }
  }

  async function stopWatcherMenu() {
    if (watchers.length === 0) {
      console.log("⚠️ No watchers running.");
      return;
    }

    const choices = watchers.map(({ config }, i) => ({
      name: `${i + 1}. 📁 ${config.watchDir} → 📄 ${config.stylesFile}`,
      value: i,
    }));

    choices.push(new inquirer.Separator());
    choices.push({ name: "Stop ALL watchers", value: "all" });
    choices.push({ name: "Cancel", value: "cancel" });

    const { toStop } = await inquirer.prompt([
      {
        type: "list",
        name: "toStop",
        message: "Select watcher to stop:",
        choices,
      },
    ]);

    if (toStop === "cancel") return;

    if (toStop === "all") {
      const { confirmAll } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmAll",
          message:
            "Are you sure? This will remove all watchers and their markers!",
          default: false,
        },
      ]);

      if (!confirmAll) return;

      for (let i = watchers.length - 1; i >= 0; i--) {
        await stopWatcher(i);
      }
    } else {
      const { confirmOne } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirmOne",
          message: `Are you sure you want to stop watcher ${toStop + 1} and remove its markers?`,
          default: false,
        },
      ]);

      if (!confirmOne) return;

      await stopWatcher(toStop);
    }

    // After stopping, update excludePaths again
    updateWatcherExclusions();
  }

  async function stopWatcher(index) {
    const { config, instance } = watchers[index];
    const watchFolderName = path.basename(
      path.resolve(config.rootDir, config.watchDir),
    );
    const stylesFilePath = path.resolve(config.rootDir, config.stylesFile);

    // Read styles file and remove markers but keep imports
    try {
      let content = require("fs").readFileSync(stylesFilePath, "utf8");

      // Regex to match from startMarker to endMarker including the markers
      // We'll keep imports inside, so we remove ONLY the marker comments
      const startMarker = `/* ${watchFolderName} import start */`;
      const endMarker = `/* ${watchFolderName} import end */`;

      // Remove only markers, keep imports inside intact
      // We'll replace the markers with empty string
      const pattern = new RegExp(
        `\\s*${escapeRegExp(startMarker)}\\s*|\\s*${escapeRegExp(endMarker)}\\s*`,
        "g",
      );

      content = content.replace(pattern, "");

      require("fs").writeFileSync(stylesFilePath, content, "utf8");
      instance.close();
      watchers.splice(index, 1);
      console.log(
        `🛑 Stopped watcher for "${watchFolderName}". Removed markers but kept imports.`,
      );
    } catch (err) {
      console.error(`❌ Error stopping watcher: ${err.message}`);
    }
  }

  function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "Choose an action:",
        choices: [
          { name: "Add new watcher", value: "add" },
          { name: "Stop watcher", value: "stop" },
          { name: "Exit", value: "exit" },
        ],
      },
    ]);

    if (action === "add") {
      await promptForWatcher();
    } else if (action === "stop") {
      await stopWatcherMenu();
    } else if (action === "exit") {
      console.log("Exiting...");
      watchers.forEach(({ instance }) => instance.close());
      break;
    }
  }
}

main();
