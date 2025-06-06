#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const scssImportWatcher = require("../index"); // This path should point to your scssImportWatcher.js file
const inquirer = require("inquirer").default;
const chokidar = require("chokidar"); // Re-add chokidar for configFileWatcher

// --- Global State ---
// watchers Map: Holds actively running watcher instances and their full configurations.
// This is primarily for managing the *live* watchers.
const watchers = new Map(); // key: name, value: { config: fullConfig, instance }

// watcherConfigs object: Holds all persistent configurations loaded from/saved to the JSON file.
// This is the source of truth for individual watcher settings.
let watcherConfigs = {}; // key: name, value: { name, watchDir, line, excludePaths }

// Global project settings - these are considered singular for the project
let _globalRootDir = null; // Determined once at startup by user input or loaded from JSON, stored as absolute path
let _globalStylesFile = null; // The single global styles file for all imports, stored as path relative to _globalRootDir

let configFileWatcher = null; // To hold the fs.FSWatcher instance for watchers.json

// --- Helper Functions ---

// Function to get the full path to the watchers.json file
function getWatchersConfigPath() {
  if (!_globalRootDir) {
    // Fallback if _globalRootDir isn't set yet (e.g., first run before prompt)
    return path.join(process.cwd(), ".scss-import-watcher-config.json");
  }
  return path.join(_globalRootDir, ".scss-import-watcher-config.json");
}

// Helper to list folders in a directory for selection
function listFolders(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const folders = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => `📁 ${entry.name}`); // Add folder icon
    return folders.sort();
  } catch (error) {
    return []; // Return empty array on error
  }
}

// Helper to list files in a directory for selection
function listFiles(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith(".scss"))
        .map((entry) => `📄 ${entry.name}`); // Keep icon for display
    return files.sort();
  } catch (error) {
    return []; // Return empty array on error
  }
}

// NEW FUNCTION: Generic directory browser (retained)
async function browseForDirectory(startDir, message) {
  let current = startDir;
  while (true) {
    // Validate current path to provide appropriate messages
    let isValidDir = false;
    try {
      const stats = fs.lstatSync(current);
      isValidDir = stats.isDirectory();
    } catch (error) {
      isValidDir = false; // Path does not exist or is not a directory
    }

    const { selection } = await inquirer.prompt([
      {
        type: "list",
        name: "selection",
        message: `${message} (Current: ${isValidDir ? path.basename(current) : "Invalid Path"})`,
        choices: [
          { name: "✅ Select this directory", value: "__SELECT__" },
          { name: "⬆️ Go up", value: "__GO_UP__" },
          ...listFolders(current).map(f => ({ name: f, value: f })),
          { name: "✏️ Enter path manually", value: "__MANUAL_INPUT__" },
        ],
        pageSize: 10,
      },
    ]);

    if (selection === "__SELECT__") {
      if (isValidDir) {
        return current;
      } else {
        console.log("❌ Cannot select an invalid directory. Please choose a valid one.");
        continue;
      }
    } else if (selection === "__GO_UP__") {
      const parent = path.dirname(current);
      if (parent === current) { // Already at root (e.g., C:\ or /)
        console.log("Already at the root.");
      } else {
        current = parent;
      }
    } else if (selection === "__MANUAL_INPUT__") {
      const { manualPath } = await inquirer.prompt([
        {
          type: "input",
          name: "manualPath",
          message: "Enter the full path:",
          default: current,
        },
      ]);
      current = manualPath;
    } else {
      // It's a folder selection
      const folderName = selection.replace(/^📁\s*/, '');
      current = path.join(current, folderName);
    }
  }
}

// Function to get the styles file (retained with icon stripping)
async function getStylesFile(rootDir) {
  let currentDir = rootDir;
  let selectedFile = null;

  while (selectedFile === null) {
    const fileChoices = listFiles(currentDir);
    const { selection } = await inquirer.prompt([
      {
        type: "list",
        name: "selection",
        message: `Select your main SCSS file (in ${path.relative(rootDir, currentDir)}):`,
        choices: [
          { name: "⬆️ Go up", value: "__GO_UP__" },
          ...fileChoices,
        ],
        pageSize: 10,
      },
    ]);

    if (selection === "__GO_UP__") {
      const parentDir = path.dirname(currentDir);
      if (parentDir !== currentDir) { // Prevent going above root
        currentDir = parentDir;
      } else {
        console.log("Already at the root.");
      }
    } else {
      // Strip the icon and any leading/trailing whitespace
      const fileName = selection.replace(/^[^\s]*\s*/, '').trim();
      selectedFile = path.relative(rootDir, path.join(currentDir, fileName)); // Ensure it's relative to rootDir
    }
  }
  return selectedFile;
}

// Function to save configurations to file
function saveConfigs(cleanup = false) {
  const configPath = getWatchersConfigPath();
  try {
    const dataToSave = {
      projectSettings: {
        rootDir: _globalRootDir,
        stylesFile: _globalStylesFile,
      },
      watchers: cleanup ? {} : watcherConfigs,
    };
    // Ensure the directory exists
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(dataToSave, null, 2), "utf8");
    // console.log("⚙️ Configuration saved."); // Only for debugging, too chatty
  } catch (error) {
    console.error("❌ Error saving config:", error.message);
  }
}

// Function to load configurations from file
async function loadConfigs() {
  const configPath = getWatchersConfigPath();
  let loadedProjectSettings = { rootDir: null, stylesFile: null };
  let loadedWatchers = {};

  if (fs.existsSync(configPath)) {
    try {
      const configData = JSON.parse(fs.readFileSync(configPath, "utf8"));
      if (configData.projectSettings) {
        loadedProjectSettings = configData.projectSettings;
      }
      if (configData.watchers) {
        loadedWatchers = configData.watchers;
      }
    } catch (error) {
      console.error(`❌ Error reading or parsing config file ${configPath}:`, error.message);
      // If parsing fails, treat it as empty config
    }
  }

  // Set global project settings directly from loaded config
  _globalRootDir = loadedProjectSettings.rootDir;
  _globalStylesFile = loadedProjectSettings.stylesFile;

  // Load individual watcher configs
  watcherConfigs = loadedWatchers;
}

// Function to apply changes to watcher instances based on current configuration
async function applyWatcherChanges() {
  const currentWatcherNames = new Set(Object.keys(watcherConfigs));

  // Stop/remove watchers that are no longer in the config
  for (const [name, { config, instance }] of watchers) {
    if (!currentWatcherNames.has(name)) {
      if (instance) {
        instance.removeMarkers(true); // Remove markers AND their contents
        instance.close();
      }
      watchers.delete(name);
      console.log(`🗑️ Watcher "${name}" removed due to config change.`);
    }
  }

  // Create/update watchers based on current config
  for (const name in watcherConfigs) {
    const config = watcherConfigs[name]; // This is the raw watcher config

    // Construct the full config for the scssImportWatcher instance
    // Use the *current* global project settings
    const fullConfig = {
      ...config,
      rootDir: _globalRootDir,
      stylesFile: _globalStylesFile,
    };

    if (watchers.has(name)) {
      // Watcher exists, check if config changed (simplified for now)
      const existing = watchers.get(name);
      // Compare the full config (including rootDir/stylesFile from globals)
      if (JSON.stringify(existing.config) !== JSON.stringify(fullConfig)) {
        // Config changed, re-initialize
        if (existing.instance) {
          existing.instance.removeMarkers(true); // Clean old markers
          existing.instance.close();
        }
        console.log(`🔄 Watcher "${name}" config changed, re-initializing.`);
        try {
          const newInstance = scssImportWatcher(fullConfig);
          newInstance._initialUpdate();
          watchers.set(name, { config: fullConfig, instance: newInstance });
          console.log(`✅ Watcher "${name}" re-initialized successfully.`);
        } catch (error) {
          console.error(`❌ Failed to re-initialize watcher "${name}":`, error.message);
        }
      }
    } else {
      // New watcher
      console.log(`➕ Creating new watcher "${name}".`);
      try {
        const instance = scssImportWatcher(fullConfig);
        instance._initialUpdate();
        watchers.set(name, { config: fullConfig, instance: instance });
        console.log(`✅ Watcher "${name}" created successfully.`);
      } catch (error) {
        console.error(`❌ Failed to create watcher "${name}":`, error.message);
      }
    }
  }
}

// Function to start watching the config file for changes
function startConfigWatcher() {
  const configPath = getWatchersConfigPath();
  if (configFileWatcher) {
    configFileWatcher.close(); // Close existing watcher if any
  }
  // Only start watching if rootDir is set, otherwise path might be invalid
  if (_globalRootDir) {
    configFileWatcher = chokidar.watch(configPath, { ignoreInitial: true, persistent: true });
    configFileWatcher.on("change", async () => {
      console.log(`\n⚙️ Config file "${path.basename(configPath)}" changed. Reloading...`);
      await loadConfigs(); // Reload all configs, will update globals
      await applyWatcherChanges(); // Apply changes to watchers, re-initializing as needed
    });
    configFileWatcher.on("unlink", () => {
      console.log(`\n⚙️ Config file "${path.basename(configPath)}" deleted. All watchers stopped.`);
      // Stop all watchers if config file is deleted
      for (const [name, { instance }] of watchers) {
        if (instance) {
          instance.removeMarkers(true);
          instance.close();
        }
      }
      watchers.clear();
      watcherConfigs = {}; // Reset in-memory config
      _globalRootDir = null; // Reset global project settings
      _globalStylesFile = null;
    });
    // console.log(`Watching config file: ${configPath}`); // For debugging
  }
}

// NEW FUNCTION: Clean and rewrite all styles files after shutdown
async function cleanAndRewriteAllStylesFiles() {
  // Ensure we have project settings before attempting cleanup
  if (!_globalRootDir || !_globalStylesFile) {
    console.warn("⚠️ Cannot perform full cleanup: Project settings (rootDir or stylesFile) are missing.");
    return;
  }

  const globalStylesFilePath = path.resolve(
      _globalRootDir,
      _globalStylesFile
  );

  if (fs.existsSync(globalStylesFilePath)) {
    try {
      // Create a dummy instance to use its removeMarkers function
      const dummyInstance = scssImportWatcher({
        rootDir: _globalRootDir,
        stylesFile: _globalStylesFile,
        watchDir: "dummy", // Required by scssImportWatcher constructor
        line: 1, // Required
        markerId: "global-cleanup" // Unique marker for global cleanup
      });
      dummyInstance.removeMarkers(true); // Call with deleteImports = true
      console.log(`✅ Global styles file cleaned: ${path.basename(globalStylesFilePath)}`);
    } catch (error) {
      console.error(`❌ Error cleaning global styles file ${path.basename(globalStylesFilePath)}:`, error.message);
    }
  } else {
    // console.log(`No global styles file found at ${path.basename(globalStylesFilePath)} for cleanup.`);
  }
}


// --- CLI Flow Functions ---

async function createWatcherFlow() {
  // Use _globalRootDir as base for watchDir selection
  const watchDir = await browseForDirectory(
      _globalRootDir,
      `Select the directory to watch for SCSS partials (relative to ${path.basename(_globalRootDir)}):`
  );
  // Store watchDir relative to rootDir
  const relativeWatchDir = path.relative(_globalRootDir, watchDir);

  // Derive default watcher name from the selected watch directory
  const defaultWatcherName = path.basename(relativeWatchDir);

  const { name } = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Enter a unique name for this watcher:", // Removed example text
      default: defaultWatcherName, // Set default to folder name
      validate: (input) =>
          input.length > 0 && !watcherConfigs[input]
              ? true
              : "Name cannot be empty and must be unique.",
    },
  ]);

  const { line } = await inquirer.prompt([
    {
      type: "input",
      name: "line",
      message: `Enter the 1-indexed line number in your main SCSS file (${_globalStylesFile}) where imports should be added:`,
      validate: (input) =>
          /^\d+$/.test(input) && parseInt(input) > 0
              ? true
              : "Please enter a valid positive line number.",
      filter: Number,
    },
  ]);

  // Optional: Exclude paths
  const excludePathsList = [];
  const { confirmExclude } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmExclude",
      message: "Do you want to add any exclusion paths? (e.g., node_modules, dist)",
      default: false,
    },
  ]);

  if (confirmExclude) {
    let addMore = true;
    while (addMore) {
      const excludedPath = await browseForDirectory(
          _globalRootDir,
          `Select a path to exclude (relative to ${path.basename(_globalRootDir)}):`
      );
      excludePathsList.push(path.resolve(_globalRootDir, excludedPath)); // Store absolute path
      const { anotherExclude } = await inquirer.prompt([
        {
          type: "confirm",
          name: "anotherExclude",
          message: "Add another exclusion path?",
          default: false,
        },
      ]);
      addMore = anotherExclude;
    }
  }

  // Store the new watcher config
  watcherConfigs[name] = {
    name,
    watchDir: relativeWatchDir, // Store relative path
    line,
    excludePaths: excludePathsList, // Store absolute paths
  };

  saveConfigs(); // Save the new watcher
  await applyWatcherChanges(); // Apply the new watcher
}

async function showWatchersFlow() {
  if (Object.keys(watcherConfigs).length === 0) {
    console.log("🤷 No watchers configured yet. Create one first!");
    return;
  }

  console.log("\n--- Active Watchers ---");
  console.log(`Project Root: ${_globalRootDir}`);
  console.log(`Styles File: ${_globalStylesFile}`);

  for (const name in watcherConfigs) {
    const config = watcherConfigs[name];
    const instanceEntry = watchers.get(name);
    const status = instanceEntry ? (instanceEntry.instance.getIsActive() ? "Active" : "Paused") : "Inactive";
    const statusIcon = instanceEntry ? (instanceEntry.instance.getIsActive() ? "🟢" : "⏸️") : "🔴";

    console.log(`\n${statusIcon} Name: ${name}`);
    console.log(`   Watch Dir: ${config.watchDir}`);
    console.log(`   Line: ${config.line}`);
    console.log(`   Status: ${status}`);
    if (config.excludePaths && config.excludePaths.length > 0) {
      console.log(`   Excluded: ${config.excludePaths.map(p => path.relative(_globalRootDir, p)).join(', ')}`);
    }

    // Show current imports if instance is active
    if (instanceEntry && instanceEntry.instance.getIsActive()) {
      const currentImports = instanceEntry.instance._getGeneratedImportPaths();
      if (currentImports.length > 0) {
        console.log(`   Current Imports (${currentImports.length}):`);
        currentImports.forEach(imp => console.log(`     - ${imp}`));
      } else {
        console.log("   No imports generated yet for this watcher.");
      }
    }
  }
  console.log("-----------------------\n");

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: "Watcher actions:",
      choices: [
        { name: "⏯️ Pause/Resume watcher(s)", value: "toggle_pause" },
        { name: "🗑️ Delete watcher(s)", value: "delete" },
        { name: "↩️ Back to main menu", value: "back" },
      ],
    },
  ]);

  if (action === "toggle_pause") {
    await togglePauseWatcherFlow();
  } else if (action === "delete") {
    await deleteWatcherFlow();
  }
}

async function deleteWatcherFlow() {
  if (Object.keys(watcherConfigs).length === 0) {
    console.log("🤷 No watchers to delete.");
    return;
  }

  const watcherNames = Object.keys(watcherConfigs);
  const { watchersToDelete } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "watchersToDelete",
      message: "Select watcher(s) to delete:",
      choices: watcherNames,
      validate: (input) =>
          input.length > 0 ? true : "Please select at least one watcher.",
    },
  ]);

  const { confirmDelete } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmDelete",
      message: `Are you sure you want to delete ${watchersToDelete.join(", ")}? This will also clean up their imports.`,
      default: false,
    },
  ]);

  if (confirmDelete) {
    for (const name of watchersToDelete) {
      const entry = watchers.get(name);
      if (entry && entry.instance) {
        entry.instance.removeMarkers(true); // Remove markers AND their contents
        entry.instance.close();
      }
      watchers.delete(name); // Remove from active watchers map
      delete watcherConfigs[name]; // Remove from persistent config
      console.log(`🗑️ Watcher "${name}" deleted.`);
    }
    saveConfigs(); // Save updated configs
  }
}

async function togglePauseWatcherFlow() {
  if (Object.keys(watcherConfigs).length === 0) {
    console.log("🤷 No watchers to pause/resume.");
    return;
  }

  const watcherChoices = Object.keys(watcherConfigs).map(name => {
    const entry = watchers.get(name);
    const status = entry && entry.instance ? (entry.instance.getIsActive() ? "Active" : "Paused") : "Inactive";
    const statusIcon = entry && entry.instance ? (entry.instance.getIsActive() ? "🟢" : "⏸️") : "🔴";
    return { name: `${statusIcon} ${name} (${status})`, value: name };
  });

  const { watchersToToggle } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "watchersToToggle",
      message: "Select watcher(s) to pause/resume:",
      choices: watcherChoices,
      validate: (input) =>
          input.length > 0 ? true : "Please select at least one watcher.",
    },
  ]);

  for (const name of watchersToToggle) {
    const entry = watchers.get(name);
    if (entry && entry.instance) {
      if (entry.instance.getIsActive()) {
        entry.instance.pause();
      } else {
        entry.instance.resume();
      }
    } else {
      console.warn(`⚠️ Watcher "${name}" is not active and cannot be toggled.`);
    }
  }
}


// --- Main Menu and Application Flow ---

async function mainMenu() {
  // Load existing configurations at startup
  await loadConfigs();

  // If rootDir and stylesFile are missing (first run or config deleted), prompt for them
  if (!_globalRootDir || !_globalStylesFile) {
    console.log("Welcome to SCSS Import Watcher! Let's set up your project first.");

    if (!_globalRootDir) {
      _globalRootDir = await browseForDirectory(
          process.cwd(),
          "Select your project's root directory:"
      );
    }
    if (!_globalStylesFile) {
      _globalStylesFile = await getStylesFile(_globalRootDir);
    }
    saveConfigs(); // Save initial project settings
  }

  // Start watching the config file after initial load/setup
  startConfigWatcher();

  // Apply changes to watcher instances based on loaded configs
  await applyWatcherChanges();

  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "Main menu:",
        choices: [
          { name: "➕ Create new watcher", value: "create" },
          { name: "👀 Show watchers", value: "show" },
          { name: "🗑️ Delete watcher(s)", value: "delete" },
          { name: "🚪 Exit", value: "exit" },
        ],
      },
    ]);

    if (action === "create") {
      await createWatcherFlow();
    } else if (action === "show") {
      await showWatchersFlow();
    } else if (action === "delete") {
      await deleteWatcherFlow();
    } else if (action === "exit") {
      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message:
              "Are you sure you want to exit? This will stop all watchers and clean up all their imports in the main styles file.",
        },
      ]);
      if (confirm) {
        // Stop all active watchers and clean their markers
        for (const [name, { instance }] of watchers) {
          if (instance) {
            instance.removeMarkers(true); // Remove markers AND their contents
            instance.close();
          }
        }
        watchers.clear(); // Clear active watchers map
        watcherConfigs = {}; // Clear persistent watchers config (will be saved empty)
        saveConfigs(true); // Save empty watchers, but keep project settings

        // Perform final cleanup of the global styles file
        await cleanAndRewriteAllStylesFiles();

        // Close the config file watcher before exiting
        if (configFileWatcher) {
          configFileWatcher.close();
        }

        console.log("👋 Bye!");
        process.exit(0);
      }
    }
  }
}

// Start the main menu flow
mainMenu();

// Graceful shutdown on Ctrl+C
process.on('SIGINT', async () => {
  console.log('\nStopping all watchers and cleaning up...');
  // Stop all active watchers and clean their markers
  for (const [name, { instance }] of watchers) {
    if (instance) {
      instance.removeMarkers(true); // Remove markers AND their contents
      instance.close();
    }
  }
  watchers.clear();
  watcherConfigs = {}; // Clear persistent watchers config (will be saved empty)
  saveConfigs(true); // Save empty watchers, but keep project settings

  // Perform final cleanup of the global styles file
  await cleanAndRewriteAllStylesFiles();

  // Close the config file watcher before exiting
  if (configFileWatcher) {
    configFileWatcher.close();
  }

  console.log("👋 Bye!");
  process.exit(0);
});