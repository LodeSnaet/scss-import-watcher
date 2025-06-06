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
let _watchersJsonPath = null;

// Global project settings - these are considered singular for the project
let _globalRootDir = null; // Determined once at startup by user input or loaded from JSON, stored as absolute path
let _globalStylesFile = null; // The single global styles file for all imports, stored as path relative to _globalRootDir

let configFileWatcher = null; // To hold the fs.FSWatcher instance for watchers.json
let saveTimeout = null; // For debouncing config file writes
const SAVE_DEBOUNCE_DELAY = 500; // milliseconds

// --- Helper Functions ---

// Function to get the full path to the watchers.json file
function getWatchersConfigPath() {
  return _watchersJsonPath || path.join(process.cwd(), "watchers.json");

}

/**
 * Synchronously saves current in-memory configurations to file.
 * This does NOT clear watcherConfigs.
 */
function _saveConfigsSync() {
  try {
    const configToSave = {
      _globalRootDir: _globalRootDir,
      _globalStylesFile: _globalStylesFile,
      watchers: watcherConfigs, // Always save the current state of watcherConfigs
    };
    const configPath = getWatchersConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(configToSave, null, 2), "utf8");
    // console.log(`\n💾 Configs saved synchronously to ${path.basename(configPath)}.`); // Commented for less clutter
  } catch (error) {
    console.error(`\n❌ Error saving configuration synchronously: ${error.message}`);
  }
}

/**
 * Saves configurations to file with a debounce.
 * Used for general CLI operations where immediate write is not critical.
 */
function saveConfigs() {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    _saveConfigsSync(); // Call the non-clearing sync save
  }, SAVE_DEBOUNCE_DELAY);
}

/**
 * New function specifically for saving on exit/SIGINT, which clears all watchers.
 */
function _saveConfigsOnExit() {
  try {
    const configToSave = {
      _globalRootDir: _globalRootDir,
      _globalStylesFile: _globalStylesFile,
      watchers: {}, // Clear watchers when saving on exit
    };
    const configPath = getWatchersConfigPath();
    fs.writeFileSync(configPath, JSON.stringify(configToSave, null, 2), "utf8");
    console.log(`\n💾 Configs cleared and saved synchronously to ${path.basename(configPath)} on exit.`);
  } catch (error) {
    console.error(`\n❌ Error saving configuration synchronously on exit: ${error.message}`);
  }
}


// Function to load configurations from file
function loadConfigs() {
  const configPath = getWatchersConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      _globalRootDir = config._globalRootDir || null;
      _globalStylesFile = config._globalStylesFile || null;
      watcherConfigs = config.watchers || {};
      console.log(`\n⚙️ Loaded configurations from ${path.basename(configPath)}.`);

      // Start watching the config file itself for external changes immediately after loading
      startWatchingConfigFile();
      return true;
    } catch (error) {
      console.error(`\n❌ Error loading configuration from ${path.basename(configPath)}: ${error.message}`);
      return false;
    }
  }
  return false;
}

// Function to start watching the config file
function startWatchingConfigFile() {
  console.log(`👀 Watching config file: ${configPath}`);

  if (configFileWatcher) {
    configFileWatcher.close(); // Close existing watcher if any
  }
  const configPath = getWatchersConfigPath();
  if (!fs.existsSync(configPath)) {
    // If config file doesn't exist yet, we can't watch it. It's created on first save.
    return;
  }

  configFileWatcher = chokidar.watch(configPath, {
    persistent: true,
    ignoreInitial: true, // Don't trigger 'change' on startup load
    usePolling: true,
    interval: 300,
    depth: 0, // Only watch the file itself
  });

  configFileWatcher.on('change', () => {
    console.log('📣 Detected watchers.json file change');

    handleExternalConfigChange();
  });
  configFileWatcher.on('error', (error) => {
    console.error(`\n❌ Error watching config file: ${error.message}`);
  });
}

// Function to handle external config file changes
async function handleExternalConfigChange() {
  console.log(`\n🔄 Config file ${path.basename(getWatchersConfigPath())} changed externally. Checking for updates...`);

  // Store current global settings and watcher configurations BEFORE attempting to load new ones
  const oldGlobalRootDir = _globalRootDir;
  const oldGlobalStylesFile = _globalStylesFile;
  const oldWatcherConfigsSnapshot = JSON.parse(JSON.stringify(watcherConfigs)); // Deep copy for comparison

  // Temporarily close the config file watcher to prevent recursive triggers during reloads/saves
  if (configFileWatcher) {
    configFileWatcher.close();
    configFileWatcher = null; // Mark as closed
  }

  // Reload configurations from file. This updates global state (_globalRootDir, _globalStylesFile, watcherConfigs).
  console.log("  Attempting to reload configurations from watchers.json...");
  const configLoadedSuccessfully = loadConfigs(); // This implicitly calls startWatchingConfigFile if successful

  if (!configLoadedSuccessfully) {
    console.error("  Failed to reload configurations from file. Reverting to previous state and re-initializing all watchers.");
    // Revert global settings and watcher configs to their previous state
    _globalRootDir = oldGlobalRootDir;
    _globalStylesFile = oldGlobalStylesFile;
    watcherConfigs = oldWatcherConfigsSnapshot;
    _saveConfigsSync(); // Overwrite the problematic external change with the valid old state
    // Re-initialize all watchers based on the restored previous state
    // First, clear all existing active instances from the map
    for (const [name, { instance }] of watchers) {
      if (instance) instance.close();
    }
    watchers.clear();
    for (const name in watcherConfigs) { // Use the reverted watcherConfigs
      await loadAndInitializeWatcher(name);
    }
    console.log("  Previous configurations restored and watchers re-initialized.");
    startWatchingConfigFile(); // Restart watching the config file
    return;
  }
  console.log("  Configurations successfully reloaded from file.");

  let globalSettingsChanged = false;
  if (_globalRootDir !== oldGlobalRootDir || _globalStylesFile !== oldGlobalStylesFile) {
    globalSettingsChanged = true;
  }

  if (globalSettingsChanged) {
    console.log(`\n🚨 WARNING: Detected external changes to global project settings.`);
    console.log(`   Project Root: Old ("${oldGlobalRootDir}") -> New ("${_globalRootDir}")`);
    console.log(`   Global Styles File: Old ("${oldGlobalStylesFile}") -> New ("${_globalStylesFile}")`);

    const { confirmGlobalUpdate } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirmGlobalUpdate',
        message: 'Do you want to apply these global changes? (Choosing No will revert to previous settings and re-initialize ALL watchers based on old settings)',
        default: true,
      },
    ]);

    if (!confirmGlobalUpdate) {
      console.log("  Global settings update cancelled. Reverting to previous settings.");
      _globalRootDir = oldGlobalRootDir;
      _globalStylesFile = oldGlobalStylesFile;
      watcherConfigs = oldWatcherConfigsSnapshot; // Revert all watcher configs too
      _saveConfigsSync(); // Immediately save the reverted state to overwrite the bad external change
    } else {
      console.log("  Applying new global settings.");
      // No need to _saveConfigsSync here because loadConfigs already did it if successful
    }
    // In either case (confirmed or reverted global change), perform a full re-initialization of ALL watchers.
    // This is because changing global root/styles file fundamentally alters how all watchers operate.
    console.log("  Performing full re-initialization of all watchers due to global settings changes.");
    // Clear all existing active instances and their markers
    for (const [name, { instance }] of watchers) {
      if (instance) {
        console.log(`  Stopping active watcher "${name}" and removing its markers...`);
        instance.removeMarkers(true); // Remove specific watcher's markers
        instance.close();
      }
    }
    watchers.clear(); // Clear all active instances from the map

    // Now, initialize all watchers based on the current (potentially new or reverted) global and watcher configs
    for (const name in watcherConfigs) {
      await loadAndInitializeWatcher(name);
    }
    console.log("  All watchers re-initialized.");
    startWatchingConfigFile(); // Restart watching the config file
    return; // Exit after handling global change and full re-init
  }

  // If no global settings changed, proceed with granular watcher updates
  console.log("  No changes in global settings detected. Proceeding to update individual watchers.");

  const newWatcherNames = Object.keys(watcherConfigs);
  const oldWatcherNames = Object.keys(oldWatcherConfigsSnapshot);

  // Identify added, modified, deleted, and unchanged watchers
  const addedWatchers = newWatcherNames.filter(name => !oldWatcherNames.includes(name));
  const deletedWatchers = oldWatcherNames.filter(name => !newWatcherNames.includes(name));
  const modifiedWatchers = newWatcherNames.filter(name => {
    if (!oldWatcherNames.includes(name)) return false; // Not a modification, it's an addition
    const oldConfig = oldWatcherConfigsSnapshot[name];
    const newConfig = watcherConfigs[name]; // This is the already loaded new config
    // Perform a deep comparison of properties
    return JSON.stringify(oldConfig) !== JSON.stringify(newConfig);
  });
  const unchangedWatchers = newWatcherNames.filter(name =>
      !addedWatchers.includes(name) && !modifiedWatchers.includes(name)
  );


  // --- Step 1: Process Deleted Watchers ---
  console.log("\n  Processing deleted watchers...");
  for (const name of deletedWatchers) {
    console.log(`  🗑️ Watcher "${name}" deleted.`);
    const watcherData = watchers.get(name);
    if (watcherData && watcherData.instance) {
      console.log(`    Cleaning up markers for "${name}"...`);
      watcherData.instance.removeMarkers(true); // Remove specific watcher's markers
      watcherData.instance.close(); // Close its instance
      watchers.delete(name); // Remove from active map
    }
    // No need to delete from `watcherConfigs` here, as `loadConfigs` already reflects the new state.

    // Remove this watcher's path from other watchers' excludePaths if it was there
    const deletedWatcherRelativeWatchDir = oldWatcherConfigsSnapshot[name]?.watchDir;
    if (deletedWatcherRelativeWatchDir) {
      // Iterate through the *current* state of watchers (which now exclude the deleted one)
      for (const otherWatcherName of Object.keys(watcherConfigs)) {
        const otherWatcherConfig = watcherConfigs[otherWatcherName]; // Use the currently loaded config
        const updatedExcludePaths = new Set(otherWatcherConfig.excludePaths);
        if (updatedExcludePaths.has(deletedWatcherRelativeWatchDir)) {
          updatedExcludePaths.delete(deletedWatcherRelativeWatchDir);
          otherWatcherConfig.excludePaths = Array.from(updatedExcludePaths);
          console.log(`    🔄 Removed "${deletedWatcherRelativeWatchDir}" from excludePaths of "${otherWatcherName}".`);
          _saveConfigsSync(); // Save the in-memory change
          // Re-initialize this other watcher to apply the updated excludePaths
          const otherWatcherInstance = watchers.get(otherWatcherName)?.instance;
          if (otherWatcherInstance) { // Only if it's currently active (might not be if it was also modified/deleted)
            console.log(`    Re-initializing "${otherWatcherName}" to apply excludePaths update...`);
            otherWatcherInstance.removeMarkers(true); // Clean old markers (if it had any)
            otherWatcherInstance.close();
            watchers.delete(otherWatcherName);
          }
          // Always call loadAndInitializeWatcher to ensure it's running with the latest config
          await loadAndInitializeWatcher(otherWatcherName);
        }
      }
    }
  }


  // --- Step 2: Process Modified Watchers ---
  console.log("\n  Processing modified watchers...");
  for (const name of modifiedWatchers) {
    console.log(`  ✏️ Watcher "${name}" modified.`);
    const oldConfig = oldWatcherConfigsSnapshot[name];
    const newConfig = watcherConfigs[name];

    // Log specific changes for better user feedback
    const changes = [];
    if (oldConfig.watchDir !== newConfig.watchDir) changes.push(`watchDir: "${oldConfig.watchDir}" -> "${newConfig.watchDir}"`);
    if (oldConfig.line !== newConfig.line) changes.push(`line: ${oldConfig.line} -> ${newConfig.line}`);
    if ((oldConfig.markerId || 'auto') !== (newConfig.markerId || 'auto')) changes.push(`markerId: "${oldConfig.markerId || 'auto'}" -> "${newConfig.markerId || 'auto'}"`);
    if (JSON.stringify(oldConfig.excludePaths) !== JSON.stringify(newConfig.excludePaths)) changes.push(`excludePaths changed`);
    changes.forEach(change => console.log(`    - ${change}`));

    // Close and remove existing instance, clean its old markers
    const watcherData = watchers.get(name);
    if (watcherData && watcherData.instance) {
      console.log(`    Cleaning up old markers for "${name}" before re-init...`);
      watcherData.instance.removeMarkers(true);
      watcherData.instance.close();
      watchers.delete(name);
    }

    // Re-initialize the modified watcher
    await loadAndInitializeWatcher(name);

    // If watchDir changed, re-evaluate exclusions for other watchers
    if (oldConfig.watchDir !== newConfig.watchDir) {
      console.log(`    Watch directory changed for "${name}". Re-evaluating exclusions for other watchers.`);
      // Iterate through the *current* state of watchers (excluding the one just modified)
      for (const otherWatcherName of Object.keys(watcherConfigs).filter(n => n !== name)) {
        const otherWatcherConfig = watcherConfigs[otherWatcherName];
        const updatedExcludePathsSet = new Set(otherWatcherConfig.excludePaths);
        let shouldUpdateOtherWatcher = false;

        const otherWatcherWatchDirAbsolute = path.resolve(_globalRootDir, otherWatcherConfig.watchDir);
        const oldWatcherWatchDirAbsolute = path.resolve(_globalRootDir, oldConfig.watchDir);
        const newWatcherWatchDirAbsolute = path.resolve(_globalRootDir, newConfig.watchDir);

        // Logic for removing old watchDir if it was a child
        const wasOtherParentOfOld = !path.relative(otherWatcherWatchDirAbsolute, oldWatcherWatchDirAbsolute).startsWith('..');
        // Check if the old watchDir *was* in the other watcher's exclusions and needs to be removed
        if (wasOtherParentOfOld && updatedExcludePathsSet.has(oldConfig.watchDir)) {
          updatedExcludePathsSet.delete(oldConfig.watchDir);
          shouldUpdateOtherWatcher = true;
          console.log(`    Removing old watchDir "${oldConfig.watchDir}" from excludePaths of "${otherWatcherName}".`);
        }

        // Logic for adding new watchDir if it is now a child
        const isOtherParentOfNew = !path.relative(otherWatcherWatchDirAbsolute, newWatcherWatchDirAbsolute).startsWith('..');
        // Check if the new watchDir *should* be in the other watcher's exclusions and isn't yet
        if (isOtherParentOfNew && !updatedExcludePathsSet.has(newConfig.watchDir)) {
          updatedExcludePathsSet.add(newConfig.watchDir);
          shouldUpdateOtherWatcher = true;
          console.log(`    Adding new watchDir "${newConfig.watchDir}" to excludePaths of "${otherWatcherName}".`);
        }

        if (shouldUpdateOtherWatcher) {
          otherWatcherConfig.excludePaths = Array.from(updatedExcludePathsSet);
          _saveConfigsSync(); // Save the in-memory change
          // Re-initialize this other watcher to apply the updated excludePaths
          const otherWatcherInstance = watchers.get(otherWatcherName)?.instance;
          if (otherWatcherInstance) { // Only if it's currently active
            console.log(`    Re-initializing "${otherWatcherName}" to apply excludePaths update...`);
            otherWatcherInstance.removeMarkers(true);
            otherWatcherInstance.close();
            watchers.delete(otherWatcherName);
          }
          // Always call loadAndInitializeWatcher to ensure it's running with the latest config
          await loadAndInitializeWatcher(otherWatcherName);
        }
      }
    }
  }

  // --- Step 3: Process Added Watchers ---
  console.log("\n  Processing added watchers...");
  for (const name of addedWatchers) {
    console.log(`  ➕ New watcher "${name}" detected.`);
    // Initialize the new watcher
    await loadAndInitializeWatcher(name);

    // Update parent watchers' excludePaths
    const newWatcherRelativeWatchDir = watcherConfigs[name].watchDir;
    // Iterate through the *current* state of watchers (excluding the one just added)
    for (const otherWatcherName of Object.keys(watcherConfigs).filter(n => n !== name)) {
      const otherWatcherConfig = watcherConfigs[otherWatcherName];
      const otherWatcherWatchDirAbsolute = path.resolve(_globalRootDir, otherWatcherConfig.watchDir);
      const newWatcherWatchDirAbsolute = path.resolve(_globalRootDir, newWatcherRelativeWatchDir);

      const isOtherParentOfNew = !path.relative(otherWatcherWatchDirAbsolute, newWatcherWatchDirAbsolute).startsWith('..');

      if (isOtherParentOfNew) {
        const updatedExcludePaths = new Set(otherWatcherConfig.excludePaths);
        if (!updatedExcludePaths.has(newWatcherRelativeWatchDir)) {
          updatedExcludePaths.add(newWatcherRelativeWatchDir);
          otherWatcherConfig.excludePaths = Array.from(updatedExcludePaths);
          console.log(`    🔄 Updated excludePaths for "${otherWatcherName}" to include new watcher "${newWatcherRelativeWatchDir}".`);
          _saveConfigsSync(); // Save the in-memory change
          // Re-initialize this other watcher to apply the updated excludePaths
          const otherWatcherInstance = watchers.get(otherWatcherName)?.instance;
          if (otherWatcherInstance) { // Only if it's currently active
            console.log(`    Re-initializing "${otherWatcherName}" to apply excludePaths update...`);
            otherWatcherInstance.removeMarkers(true);
            otherWatcherInstance.close();
            watchers.delete(otherWatcherName);
          }
          // Always call loadAndInitializeWatcher to ensure it's running with the latest config
          await loadAndInitializeWatcher(otherWatcherName);
        }
      }
    }
  }

  // If we reached this point, it means no global settings change led to a full restart.
  // Unchanged watchers were left running. Modified/added watchers were restarted. Deleted ones were cleaned up.
  console.log("✅ Watcher configurations synchronized. Unchanged watchers remain active.");

  startWatchingConfigFile(); // Restart watching the config file after all operations
}


// Helper to list folders and files in a directory
function listFoldersAndFiles(dir) {
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const folders = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => `📁 ${entry.name}`); // Add folder icon
    return { folders: folders.sort() };
  } catch (error) {
    console.error(`\n❌ Error reading directory ${dir}: ${error.message}`);
    return { folders: [] }; // Return empty array on error
  }
}

// NEW FUNCTION: Generic directory browser
async function browseForDirectory(startDir, message, isRootRestricted = false, rootUpperBound = null) { // Added rootUpperBound
  let current = startDir;
  const actualRootUpperBound = rootUpperBound || path.parse(current).root; // Default to system root if no upper bound given

  while (true) {
    // Validate current path to provide appropriate messages
    let isValidDir = false;
    try {
      const stats = fs.lstatSync(current);
      isValidDir = stats.isDirectory();
    } catch (error) {
      isValidDir = false; // Path does not exist or is not a directory
    }

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: message,
        choices: [
          {
            name: `(Current: ${isValidDir ? current : "Invalid Path"})`,
            value: "current_path_label",
            disabled: true, // This is a label, not an action, should always be disabled.
          },
          ...listFoldersAndFiles(current).folders,
          new inquirer.Separator(),
          {
            name: "⬆️ Go up a directory",
            value: "up",
            // Disable if we are at the system root OR above the restricted upper bound
            disabled: current === actualRootUpperBound || path.relative(actualRootUpperBound, current).startsWith('..')
          },
          { name: "✅ Select this directory", value: "select", disabled: !isValidDir },
          {
            name: "🏠 Go to Project Root",
            value: "root",
            // Disable if project root is not set, or if already at project root,
            // or if restricted and already at global root (to avoid redundant option)
            disabled: !_globalRootDir || current === _globalRootDir || (isRootRestricted && current === _globalRootDir)
          },
          { name: "🚪 Exit directory browser", value: "exit" },
        ],
      },
    ]);

    if (action === "select") {
      return current;
    } else if (action === "up") {
      current = path.dirname(current);
    } else if (action === "exit") {
      return null; // User cancelled
    } else if (action === "root") {
      current = _globalRootDir;
    } else {
      current = path.join(current, action.replace("📁 ", "")); // Navigate into selected folder
    }
  }
}

// NEW FUNCTION: Browse for a specific file (e.g., watchers.json) - (Not currently used but good to have)
async function browseForFile(startDir, message, fileExtension = '', fileNameOnly = null) {
  let current = startDir;
  while (true) {
    let filesInDir = [];
    try {
      const entries = fs.readdirSync(current, { withFileTypes: true });
      filesInDir = entries
          .filter(entry => entry.isFile() &&
              (fileExtension === '' || entry.name.endsWith(fileExtension)) &&
              (fileNameOnly === null || entry.name === fileNameOnly) // Filter by exact file name if provided
          )
          .map(entry => `📄 ${entry.name}`)
          .sort();
    } catch (error) {
      console.error(`\n❌ Error reading directory ${current}: ${error.message}`);
    }

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: message,
        choices: [
          {
            name: `(Current: ${current})`,
            value: "current_path_label",
            disabled: true,
          },
          ...listFoldersAndFiles(current).folders, // Show folders for navigation
          ...filesInDir, // Show files
          new inquirer.Separator(),
          { name: "⬆️ Go up a directory", value: "up", disabled: current === path.parse(current).root },
          { name: "🚪 Cancel", value: "cancel" },
        ],
      },
    ]);

    if (action === "cancel") {
      return null; // User cancelled
    } else if (action === "up") {
      current = path.dirname(current);
    } else if (action.startsWith("📁 ")) { // Navigating into a folder
      current = path.join(current, action.replace("📁 ", ""));
    } else if (action.startsWith("📄 ")) { // Selected a file
      return path.join(current, action.replace("📄 ", ""));
    }
  }
}


// NEW FUNCTION: Browse for a single SCSS file DIRECTLY in a given directory (no recursion)
async function browseForScssFileInDirectory(searchDir, message) {
  let scssFiles = [];
  try {
    const entries = fs.readdirSync(searchDir, { withFileTypes: true });
    scssFiles = entries
        .filter(entry => entry.isFile() && entry.name.endsWith('.scss'))
        .map(entry => entry.name)
        .sort();
  } catch (error) {
    console.error(`\n❌ Error reading directory ${searchDir}: ${error.message}`);
    return null;
  }

  if (scssFiles.length === 0) {
    console.log(`\n⚠️ No .scss files found directly in "${searchDir}".`);
    const { retry } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'retry',
        message: 'Do you want to re-select a file in this directory, or cancel?',
        default: true,
      },
    ]);
    if (retry) {
      return 'RETRY_SELECTION'; // Special signal to re-prompt for file selection in the same directory
    }
    return null; // User cancelled
  }

  const { selectedFile } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedFile",
      message: message,
      choices: [
        ...scssFiles,
        new inquirer.Separator(),
        { name: "🚪 Cancel", value: "cancel" },
      ],
    },
  ]);

  if (selectedFile === "cancel") {
    return null;
  }
  return path.join(searchDir, selectedFile);
}


// NEW FUNCTION: Prompt for relative paths (e.g., excludePaths)
async function promptForRelativePaths(baseDir, message, defaultValue = '') {
  const { pathsInput } = await inquirer.prompt([
    {
      type: 'input',
      name: 'pathsInput',
      message: message,
      default: defaultValue,
      filter: (input) => input.split(',').map(p => p.trim()).filter(p => p !== ''),
    },
  ]);
  // Validate that paths are indeed relative to baseDir if needed
  // For now, just return the filtered array
  return pathsInput;
}


// Function to load and initialize a single watcher
async function loadAndInitializeWatcher(name) {
  const config = watcherConfigs[name];
  if (!config) {
    console.log(`\n❌ Configuration for watcher "${name}" not found.`);
    return;
  }

  // Ensure rootDir and stylesFile are always absolute paths in the passed config
  const fullConfig = {
    ...config,
    rootDir: _globalRootDir, // This is always absolute from loadConfigs
    stylesFile: _globalStylesFile, // This is relative to _globalRootDir
    // NEW: Pass the entire watcherConfigs for cross-watcher filtering
    allWatchersConfigs: watcherConfigs // Pass the live, potentially updated watcherConfigs
  };

  try {
    console.log(`  Initializing watcher "${name}" with config:`);
    console.log(`    watchDir: "${fullConfig.watchDir}"`);
    console.log(`    line: ${fullConfig.line}`);
    console.log(`    excludePaths: [${fullConfig.excludePaths.join(', ')}]`);

    const instance = scssImportWatcher(fullConfig);
    instance._initialUpdate(); // Perform initial update to generate imports
    watchers.set(name, { config: fullConfig, instance });
    console.log(`\n✨ Watcher "${name}" initialized.`);
  } catch (error) {
    console.error(`\n❌ Error initializing watcher "${name}":`, error.message);
    // If initialization fails, log the error but don't remove from watcherConfigs
    // as it might be a temporary issue or misconfiguration that the user can edit.
  }
}

// Initial setup for _globalRootDir and _globalStylesFile
async function setupProjectRootAndStylesFile() {
  console.log("\n--- Initial Project Setup ---");
  console.log("This tool needs to know your main project root, your primary SCSS file, and your watchers.json file.");

  let currentWorkingDir = process.cwd();
  let rootDirSelected = false;

  // Step 1: Select Project Root
  while (!rootDirSelected) {
    const rootDirAbsolute = await browseForDirectory(
        currentWorkingDir,
        "Select your main project root directory:",
        true,
        currentWorkingDir
    );

    if (!rootDirAbsolute) {
      console.log("Project root selection cancelled. Cannot proceed.");
      process.exit(0);
    }

    _globalRootDir = rootDirAbsolute;
    rootDirSelected = true;
  }

  // Step 2: Select Main SCSS File
  let stylesFileSelected = false;
  while (!stylesFileSelected) {
    console.log(`\nNow, select your primary SCSS file (e.g., main.scss, app.scss). It must be directly in: ${_globalRootDir}`);
    const stylesFileAbsolute = await browseForScssFileInDirectory(
        _globalRootDir,
        "Select your main SCSS file to be updated (must be in the project root):"
    );

    if (stylesFileAbsolute === 'RETRY_SELECTION') {
      continue;
    }

    if (!stylesFileAbsolute) {
      console.log("Main SCSS file selection cancelled. Cannot proceed.");
      process.exit(0);
    }

    _globalStylesFile = path.relative(_globalRootDir, stylesFileAbsolute);
    if (!_globalStylesFile.endsWith('.scss')) {
      console.warn("⚠️ Warning: The selected file does not have a .scss extension. Ensure it's a valid SCSS file.");
    }

    stylesFileSelected = true;
  }

  // Step 3: Select watchers.json in root only (no folder browsing)
  console.log(`\nLooking for .json files in: ${_globalRootDir}`);
  const entries = fs.readdirSync(_globalRootDir, { withFileTypes: true });
  const jsonFiles = entries
      .filter(e => e.isFile() && e.name.endsWith('.json'))
      .map(e => e.name);

  if (jsonFiles.length === 0) {
    console.log("❌ No JSON files found in the selected root directory.");
    process.exit(1);
  }

  const { selectedJson } = await inquirer.prompt([
    {
      type: 'list',
      name: 'selectedJson',
      message: 'Select a watchers.json file from the root (no folders allowed):',
      choices: jsonFiles
    }
  ]);

  _watchersJsonPath = path.join(_globalRootDir, selectedJson);
  console.log(`📄 Selected config: ${_watchersJsonPath}`);

  // Step 4: Load Config
  let loadedSuccessfully = false;

  try {
    const config = JSON.parse(fs.readFileSync(_watchersJsonPath, "utf8"));
    const loadedRootDir = config._globalRootDir;
    const loadedStylesFile = config._globalStylesFile;
    const loadedWatchers = config.watchers || {};

    if (!loadedRootDir || !loadedStylesFile) {
      console.error("\n❌ The selected watchers.json file is missing required global settings.");
    } else {
      watcherConfigs = loadedWatchers;
      console.log("✅ Loaded watcher configurations from file.");
      loadedSuccessfully = true;
    }
  } catch (error) {
    console.error(`\n❌ Failed to load or parse selected watchers.json: ${error.message}`);
  }

  if (!loadedSuccessfully) {
    watcherConfigs = {};
    console.warn("⚠️ Starting with empty watcher configuration.");
    _saveConfigsSync();
  }

  // Final Confirmation
  console.log(`\n--- Project Settings Summary ---`);
  console.log(`📁 Project Root Set: ${_globalRootDir}`);
  console.log(`📄 Global Styles File Set: ${path.join(path.basename(_globalRootDir), _globalStylesFile)}`);
  console.log(`📜 Config File: ${_watchersJsonPath}`);

  const { continueSetup } = await inquirer.prompt({
    type: "confirm",
    name: "continueSetup",
    message: "Are these settings correct? Continue to Main Menu?",
    default: true,
  });

  if (!continueSetup) {
    console.log("Project setup cancelled. Exiting.");
    process.exit(0);
  }
}


// Function to create a new watcher
async function createWatcherFlow() {
  console.log("\n--- Create New Watcher ---");

  const watchDirAbsolute = await browseForDirectory(
      _globalRootDir, // Start from the global root directory
      "Select the directory to watch for SCSS partials (cannot go outside project root):",
      true, // isRootRestricted = true
      _globalRootDir // The root upper bound for watcher directories is the project root
  );

  if (!watchDirAbsolute) {
    console.log("Watcher creation cancelled: No watch directory selected.");
    return;
  }

  const newWatcherWatchDirRelative = path.relative(_globalRootDir, watchDirAbsolute);
  if (newWatcherWatchDirRelative === '') {
    console.warn("⚠️ Warning: Watching the project root. Ensure your main styles file is excluded if it's in the root.");
  }

  const { name } = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Enter a unique name for the watcher:",
      default: path.basename(watchDirAbsolute), // Default to folder name
      validate: (input) => {
        if (input.trim() === "") {
          return "Watcher name cannot be empty.";
        }
        if (watcherConfigs[input.trim()]) {
          return "A watcher with this name already exists. Please choose a different name.";
        }
        return true;
      },
    },
  ]);

  const { line } = await inquirer.prompt([
    {
      type: "input",
      name: "line",
      message: `Enter the 1-indexed line number in ${_globalStylesFile} where imports should be inserted:`,
      default: 1,
      validate: (input) => {
        const num = parseInt(input);
        if (isNaN(num) || num <= 0) {
          return "Please enter a valid positive number.";
        }
        return true;
      },
      filter: Number,
    },
  ]);

  const { markerId } = await inquirer.prompt([
    {
      type: "input",
      name: "markerId",
      message: "Enter a unique marker ID for this watcher (optional, defaults to watchDir name):",
      default: '',
      filter: (input) => input.trim() === '' ? undefined : input.trim(), // Use undefined to signal default behavior
    },
  ]);

  watcherConfigs[name] = {
    name,
    watchDir: newWatcherWatchDirRelative,
    line,
    markerId,
    excludePaths: [] // Initialize as empty for the new watcher
  };

  // --- NEW LOGIC: Update parent watchers' excludePaths ---
  for (const existingWatcherName in watcherConfigs) {
    if (existingWatcherName === name) {
      continue; // Skip the new watcher itself
    }
    const existingWatcherConfig = watcherConfigs[existingWatcherName];
    const existingWatcherWatchDirAbsolute = path.resolve(_globalRootDir, existingWatcherConfig.watchDir);

    // Determine if the new watcher's directory is a child of the existing watcher's directory
    const relativePathFromExistingToNew = path.relative(existingWatcherWatchDirAbsolute, watchDirAbsolute);

    // If relativePathFromExistingToNew does not start with '..' and is not empty,
    // then newWatcherWatchDirRelative is a child of existingWatcherConfig.watchDir
    if (!relativePathFromExistingToNew.startsWith('..') && relativePathFromExistingToNew !== '') {
      const updatedExcludePaths = new Set(existingWatcherConfig.excludePaths);
      updatedExcludePaths.add(newWatcherWatchDirRelative); // Add the new watcher's relative path

      // Only update and re-initialize if the excludePaths actually changed (to prevent unnecessary writes/reloads)
      if (updatedExcludePaths.size > existingWatcherConfig.excludePaths.length) {
        existingWatcherConfig.excludePaths = Array.from(updatedExcludePaths);
        console.log(`\n🔄 Updated excludePaths for existing watcher "${existingWatcherName}" to include "${newWatcherWatchDirRelative}".`);
        _saveConfigsSync(); // Save the in-memory change
        // Re-initialize the parent watcher to apply the new excludePaths
        // This will also trigger removeMarkers(true) on the old instance and then regenerate imports
        const existingInstance = watchers.get(existingWatcherName)?.instance;
        if (existingInstance) {
          console.log(`  Cleaning up old markers for "${existingWatcherName}" before re-init...`);
          existingInstance.removeMarkers(true); // Clean up old markers AND their content
          existingInstance.close(); // Close old watcher instance
          watchers.delete(existingWatcherName); // Remove old instance from map
          console.log(`  Old instance for "${existingWatcherName}" cleaned and removed.`);
        }
        await loadAndInitializeWatcher(existingWatcherName); // Load and initialize with new config
      }
    }
  }
  // --- END NEW LOGIC ---

  _saveConfigsSync(); // Use synchronous save after all updates, ensures consistency
  console.log(`\nWatcher "${name}" configured.`);

  await loadAndInitializeWatcher(name); // Initialize the new watcher
}

// Function to show all configured watchers
async function showWatchersFlow() {
  if (Object.keys(watcherConfigs).length === 0) {
    console.log("\nNo watchers configured yet.");
    return;
  }

  const watcherChoices = Object.keys(watcherConfigs).map((name) => {
    const watcherData = watchers.get(name);
    // Check if instance exists and is active
    const isActive = watcherData && watcherData.instance ? watcherData.instance.getIsActive() : false;
    return {
      name: `${name} (${isActive ? '✅ Active' : '🔴 Inactive'}) - Watch: ${watcherConfigs[name].watchDir}`,
      value: name,
    };
  });

  const { selectedWatcher } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedWatcher",
      message: "Select a watcher to view details or edit:",
      choices: [
        ...watcherChoices,
        new inquirer.Separator(),
        { name: "🔙 Back to Main Menu", value: "back" },
      ],
    },
  ]);

  if (selectedWatcher && selectedWatcher !== "back") {
    await manageWatcherDetails(selectedWatcher);
  }
  // If 'back' is selected or no watchers, it will naturally return to main menu loop
}


// NEW FUNCTION: Manage Watcher Details
async function manageWatcherDetails(watcherName) {
  const watcherData = watchers.get(watcherName); // Get live instance data
  const config = watcherConfigs[watcherName]; // Get persistent config

  if (!config) {
    console.log(`\n❌ Watcher "${watcherName}" configuration not found.`);
    return; // Should not happen if selected from list
  }

  console.log(`\n--- Details for Watcher: ${config.name} ---`);
  console.log(`  Watch Directory (relative to root): ${config.watchDir}`);
  console.log(`  Watch Directory (absolute): ${path.resolve(_globalRootDir, config.watchDir)}`);
  console.log(`  Insert Line: ${config.line}`);
  console.log(`  Marker ID: ${config.markerId || 'auto'}`);
  console.log(`  Exclude Paths (relative to root): ${config.excludePaths && config.excludePaths.length > 0 ? config.excludePaths.join(', ') : 'None'}`);

  let currentImports = [];
  let isActive = false;

  if (watcherData && watcherData.instance) {
    isActive = watcherData.instance.getIsActive();
    console.log(`  Status: ${isActive ? '✅ Active' : '⏸️ Paused'}`);
    currentImports = watcherData.instance._getGeneratedImportPaths();
    console.log(`\n--- Current Imports ---`);
    if (currentImports.length > 0) {
      // The _getGeneratedImportPaths already returns "@import "..."", so just print it.
      currentImports.forEach(imp => console.log(`  ${imp}`));
    } else {
      console.log(`  No imports generated yet, or no SCSS partials found.`);
    }
  } else {
    console.log(`  Status: 🔴 Inactive (Instance not running or failed to initialize)`);
    console.log(`\n--- Current Imports ---`);
    console.log(`  No imports available (watcher instance not active).`);
  }
  console.log(`------------------------`);

  const { action } = await inquirer.prompt([
    {
      type: "list",
      name: "action",
      message: `Actions for "${config.name}":`,
      choices: [
        { name: "✏️ Edit Watcher Settings", value: "edit" },
        { name: "🔙 Back to Show Watchers", value: "back" },
      ],
    },
  ]);

  if (action === "edit") {
    await editWatcherFlow(watcherName);
    // After editing, show details again
    await manageWatcherDetails(watcherName); // Re-show details after edit
  } else if (action === "back") {
    // This will naturally return to showWatchersFlow, no explicit call needed here
  }
}

// NEW FUNCTION: Edit Watcher Flow
async function editWatcherFlow(watcherName) {
  const config = watcherConfigs[watcherName];
  if (!config) {
    console.log(`\n❌ Watcher "${watcherName}" configuration not found.`);
    return;
  }

  const { confirmEdit } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmEdit",
      message: `Are you sure you want to proceed editing "${watcherName}"? This won't break anything, but it will change the watcher's settings and update its imports.`,
      default: false,
    },
  ]);

  if (!confirmEdit) {
    console.log(`\nEdit for "${watcherName}" cancelled.`);
    return;
  }

  console.log(`\n--- Editing Watcher: ${watcherName} ---`);
  console.log(`(Press Enter to keep current value)`);

  // Store the old watchDir before updating for comparison later
  const oldWatchDirRelative = config.watchDir;
  const oldConfigSnapshot = JSON.parse(JSON.stringify(config)); // Deep copy for comparison

  // Prompt for new watchDir
  const currentWatchDirAbsolute = path.resolve(_globalRootDir, config.watchDir);
  const newWatchDirAbsolute = await browseForDirectory(
      currentWatchDirAbsolute,
      `Select new watch directory (current: ${config.watchDir}):`,
      true, // isRootRestricted = true
      _globalRootDir // Upper bound is project root
  );
  // If user cancels browseForDirectory, it returns null. Keep old value.
  const newWatchDirRelative = newWatchDirAbsolute ? path.relative(_globalRootDir, newWatchDirAbsolute) : config.watchDir;


  // Prompt for new line number
  const { newLine } = await inquirer.prompt([
    {
      type: "input",
      name: "newLine",
      message: `Enter new line number for imports (current: ${config.line}):`,
      validate: (input) => {
        // Allow empty string to keep current value
        if (input.trim() === '') return true;
        const num = parseInt(input);
        if (isNaN(num) || num <= 0) {
          return "Please enter a valid positive number.";
        }
        return true;
      },
      default: String(config.line), // Convert to string for default
      filter: (input) => input.trim() === '' ? config.line : parseInt(input), // Filter to keep original if empty, otherwise parse
    },
  ]);

  // Prompt for new markerId
  const { newMarkerId } = await inquirer.prompt([
    {
      type: "input",
      name: "newMarkerId",
      message: "Enter new unique marker ID (current: ${config.markerId || 'auto'}):",
      default: config.markerId || '', // Provide empty string if it was 'auto'
      filter: (input) => input.trim() === '' ? undefined : input.trim(), // Use undefined for 'auto'
    },
  ]);

  // Prompt to edit exclude paths
  const { editExcludePaths } = await inquirer.prompt([
    {
      type: "confirm",
      name: "editExcludePaths",
      message: `Do you want to edit exclude paths? (Current: ${config.excludePaths && config.excludePaths.length > 0 ? config.excludePaths.join(', ') : 'None'})`,
      default: false,
    },
  ]);

  let newExcludePaths = config.excludePaths || [];
  if (editExcludePaths) {
    newExcludePaths = await promptForRelativePaths(
        _globalRootDir,
        `Enter new exclude paths (relative to ${_globalRootDir}). Separate by comma. Press Enter for none:`,
        newExcludePaths.join(',')
    );
  }

  // Update configuration object in memory
  config.watchDir = newWatchDirRelative;
  config.line = newLine;
  config.markerId = newMarkerId;
  config.excludePaths = newExcludePaths;

  _saveConfigsSync(); // Immediately save the updated watcher config to watchers.json

  console.log(`\n✅ Watcher "${watcherName}" configuration updated and saved.`);

  // If the watcher's config actually changed, re-initialize it
  if (JSON.stringify(oldConfigSnapshot) !== JSON.stringify(config)) {
    console.log(`\nWatcher "${watcherName}" configuration changed. Re-initializing...`);

    // Clean up old markers for the currently edited watcher
    const existingInstance = watchers.get(watcherName)?.instance;
    if (existingInstance) {
      console.log(`  Cleaning up old markers for "${watcherName}" before re-init...`);
      existingInstance.removeMarkers(true); // Clean up old markers AND their content
      existingInstance.close(); // Close old watcher instance
      watchers.delete(watcherName); // Remove old instance from map
      console.log(`  Old instance for "${watcherName}" cleaned and removed.`);
    }

    // Load and initialize the watcher with the new configuration
    await loadAndInitializeWatcher(watcherName);
    console.log(`\nWatcher "${watcherName}" reinitialized with new settings.`);
  } else {
    console.log(`\nNo changes detected for "${watcherName}". No re-initialization needed.`);
  }

  // Regardless of whether the current watcher was modified, if its watchDir changed,
  // we might need to re-evaluate exclusions for other watchers.
  if (oldWatchDirRelative !== newWatchDirRelative) {
    console.log(`\nWatch directory for "${watcherName}" changed. Re-evaluating exclusions for all other watchers...`);
    // Re-evaluate and re-initialize all other watchers to update their exclusion lists
    for (const nameOfOtherWatcher in watcherConfigs) {
      if (nameOfOtherWatcher === watcherName) continue; // Skip the currently edited watcher

      const otherWatcherConfig = watcherConfigs[nameOfOtherWatcher];
      const otherWatcherWatchDirAbsolute = path.resolve(_globalRootDir, otherWatcherConfig.watchDir);

      const updatedExcludePathsSet = new Set(otherWatcherConfig.excludePaths);
      let shouldUpdateOtherWatcher = false;

      // Check if the old watchDir of the current watcher was a child of this other watcher
      const relativePathFromOtherToOld = path.relative(otherWatcherWatchDirAbsolute, path.resolve(_globalRootDir, oldWatchDirRelative));
      const isOtherParentOfOld = !relativePathFromOtherToOld.startsWith('..') && relativePathFromOtherToOld !== '';
      if (isOtherParentOfOld && updatedExcludePathsSet.has(oldWatchDirRelative)) {
        updatedExcludePathsSet.delete(oldWatchDirRelative);
        shouldUpdateOtherWatcher = true;
        console.log(`  Removing old watchDir "${oldWatchDirRelative}" from excludePaths of "${nameOfOtherWatcher}".`);
      }

      // Check if the new watchDir of the current watcher is now a child of this other watcher
      const relativePathFromOtherToNew = path.relative(otherWatcherWatchDirAbsolute, path.resolve(_globalRootDir, newWatchDirRelative));
      const isOtherParentOfNew = !relativePathFromOtherToNew.startsWith('..') && relativePathFromOtherToNew !== '';
      if (isOtherParentOfNew && !updatedExcludePathsSet.has(newWatchDirRelative)) {
        updatedExcludePathsSet.add(newWatchDirRelative);
        shouldUpdateOtherWatcher = true;
        console.log(`  Adding new watchDir "${newWatchDirRelative}" to excludePaths of "${nameOfOtherWatcher}".`);
      }

      if (shouldUpdateOtherWatcher) {
        otherWatcherConfig.excludePaths = Array.from(updatedExcludePathsSet);
        _saveConfigsSync(); // Immediately save the updated config of this other watcher
        // Re-initialize the other watcher to apply its updated excludePaths
        const otherWatcherInstance = watchers.get(nameOfOtherWatcher)?.instance;
        if (otherWatcherInstance) {
          console.log(`  Cleaning up old markers for "${nameOfOtherWatcher}" before re-init...`);
          otherWatcherInstance.removeMarkers(true);
          otherWatcherInstance.close();
          watchers.delete(nameOfOtherWatcher);
          console.log(`  Old instance for "${nameOfOtherWatcher}" cleaned and removed.`);
        }
        await loadAndInitializeWatcher(nameOfOtherWatcher);
      }
    }
  }
}


// Function to delete one or more watchers
async function deleteWatcherFlow(watcherToDelete = null) {
  if (Object.keys(watcherConfigs).length === 0) {
    console.log("\nNo watchers to delete.");
    return;
  }

  let choices = Object.keys(watcherConfigs).map((name) => ({
    name: name,
    value: name,
  }));

  if (watcherToDelete === null) {
    const { watchersSelected } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "watchersSelected",
        message: "Select watcher(s) to delete:",
        choices: choices,
        validate: (input) =>
            input.length > 0 ? true : "Please select at least one watcher.",
      },
    ]);
    watcherToDelete = watchersSelected; // Array of names
  } else {
    // If a single watcher was passed directly (e.g., from an error handler)
    watcherToDelete = [watcherToDelete]; // Convert to array for consistent processing
  }

  const { confirmDelete } = await inquirer.prompt([
    {
      type: "confirm",
      name: "confirmDelete",
      message: `Are you sure you want to delete ${watcherToDelete.length} watcher(s)? This will remove their configuration and clean up their imports from ${_globalStylesFile}.`,
      default: false,
    },
  ]);

  if (confirmDelete) {
    for (const name of watcherToDelete) {
      const watcherData = watchers.get(name);
      if (watcherData && watcherData.instance) {
        console.log(`\n  Cleaning up markers for "${name}" before deletion...`);
        watcherData.instance.removeMarkers(true); // Remove markers AND their contents
        watcherData.instance.close(); // Close the watcher instance
      }
      watchers.delete(name); // Remove from active watchers map
      // Store the watchDir before deleting the config for exclusion removal logic
      const deletedWatcherRelativeWatchDir = watcherConfigs[name] && watcherConfigs[name].watchDir;
      delete watcherConfigs[name]; // Remove from persistent config in memory
      _saveConfigsSync(); // Save immediately after deleting a watcher's config

      console.log(`\n🗑️ Watcher "${name}" deleted and imports cleaned up.`);

      // --- NEW LOGIC: Remove deleted watcher's path from other watchers' excludePaths ---
      if (deletedWatcherRelativeWatchDir) {
        for (const otherWatcherName in watcherConfigs) {
          const otherWatcherConfig = watcherConfigs[otherWatcherName];
          const updatedExcludePaths = new Set(otherWatcherConfig.excludePaths);
          if (updatedExcludePaths.has(deletedWatcherRelativeWatchDir)) {
            updatedExcludePaths.delete(deletedWatcherRelativeWatchDir);
            otherWatcherConfig.excludePaths = Array.from(updatedExcludePaths);
            console.log(`\n🔄 Removed "${deletedWatcherRelativeWatchDir}" from excludePaths of watcher "${otherWatcherName}".`);
            _saveConfigsSync(); // Save the in-memory change
            // Re-initialize the other watcher to apply the updated excludePaths
            const otherWatcherInstance = watchers.get(otherWatcherName)?.instance;
            if (otherWatcherInstance) {
              console.log(`  Cleaning up old markers for "${otherWatcherName}" before re-init...`);
              otherWatcherInstance.removeMarkers(true);
              otherWatcherInstance.close();
              watchers.delete(otherWatcherName);
              console.log(`  Old instance for "${otherWatcherName}" cleaned and removed.`);
            }
            await loadAndInitializeWatcher(otherWatcherName);
          }
        }
      }
      // --- END NEW LOGIC ---
    }
  } else {
    console.log("\nDeletion cancelled.");
  }
}

// Function to clean up all imports from a given styles file (used on exit or if project config changes)
async function cleanAndRewriteAllStylesFiles() {
  if (!_globalStylesFile || !_globalRootDir) {
    // console.log("No global styles file or root directory configured for cleanup.");
    return;
  }

  const absoluteStylesFilePath = path.resolve(_globalRootDir, _globalStylesFile);
  if (!fs.existsSync(absoluteStylesFilePath)) {
    // console.log(`Global styles file not found at ${absoluteStylesFilePath}. No cleanup needed.`);
    return;
  }

  try {
    let content = fs.readFileSync(absoluteStylesFilePath, "utf8");
    const lines = content.split('\n');

    // Dynamically create regex to find ALL markers for ALL watchers
    const allMarkerIds = new Set(Object.keys(watcherConfigs)); // Use Set for unique IDs from current config
    // Also include IDs from active watchers that might not be in config yet (shouldn't happen, but for robustness)
    for (const [name, { config }] of watchers) {
      if (config.markerId) {
        allMarkerIds.add(config.markerId);
      } else {
        // Default marker ID if not explicitly set
        allMarkerIds.add(path.basename(config.watchDir).replace(/[\/\\]/g, '_').replace(/^_/, ''));
      }
    }


    let cleanedLines = [];
    let insideMarkerBlock = false;
    let relevantMarkerFound = false; // Flag to track if any known marker was found

    // Helper to escape special characters in a string for use in a RegExp
    function escapeRegExp(string) {
      return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the matched substring
    }

    const startMarkerRegexes = Array.from(allMarkerIds).map(id => new RegExp(`^/\\* ${escapeRegExp(id)} import start \\*/$`, 'm'));
    const endMarkerRegexes = Array.from(allMarkerIds).map(id => new RegExp(`^/\\* ${escapeRegExp(id)} import end \\*/$`, 'm'));

    for (const line of lines) {
      let isStartMarker = startMarkerRegexes.some(regex => regex.test(line.trim()));
      let isEndMarker = endMarkerRegexes.some(regex => regex.test(line.trim()));

      if (isStartMarker) {
        insideMarkerBlock = true;
        relevantMarkerFound = true;
        // Do not add start marker to cleanedLines if we are deleting it
      } else if (isEndMarker) {
        insideMarkerBlock = false;
        relevantMarkerFound = true;
        // Do not add end marker to cleanedLines if we are deleting it
      } else if (!insideMarkerBlock) {
        cleanedLines.push(line);
      }
    }

    if (relevantMarkerFound) {
      const finalContent = cleanedLines.join('\n').replace(/\n{3,}/g, '\n\n'); // Normalize multiple newlines
      fs.writeFileSync(absoluteStylesFilePath, finalContent, "utf8");
      console.log(`\n🧹 Cleaned up all managed import blocks in ${path.basename(absoluteStylesFilePath)}.`);
    } else {
      // console.log(`No managed import blocks found in ${path.basename(absoluteStylesFilePath)}. No cleanup performed.`);
    }

  } catch (error) {
    console.error(`\n❌ Error during final styles file cleanup ${path.basename(absoluteStylesFilePath)}: ${error.message}`);
  }
}


// --- Main Menu Flow ---
async function mainMenu() {
  // Ensure _globalRootDir and _globalStylesFile are set before entering the loop
  if (!_globalRootDir || !_globalStylesFile) {
    // If no config loaded or incomplete, prompt for initial setup
    await setupProjectRootAndStylesFile(); // Call the setup function
    if (!_globalRootDir || !_globalStylesFile) {
      console.log("\nInitial setup incomplete. Exiting.");
      process.exit(0);
    }
  }

  // Initialize all watchers on startup (after rootDir/stylesFile are known)
  // This is a one-time init for watchers found in watcherConfigs on startup.
  // handleExternalConfigChange will manage subsequent updates.
  for (const name in watcherConfigs) {
    if (!watchers.has(name)) { // Only initialize if not already running
      await loadAndInitializeWatcher(name);
    }
  }

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
      await deleteWatcherFlow(null);
    } else if (action === "exit") {
      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message:
              "Are you sure you want to exit? This will stop all watchers and clean up all their imports.",
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
        _saveConfigsOnExit(); // Use new synchronous save on exit to clear file
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
// Load configs first, then proceed to main menu
loadConfigs();
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
  _saveConfigsOnExit(); // Use new synchronous save on exit to clear file

  // Perform final cleanup of the global styles file
  await cleanAndRewriteAllStylesFiles();

  // Close the config file watcher before exiting
  if (configFileWatcher) {
    configFileWatcher.close();
  }

  console.log("👋 Bye!");
  process.exit(0);
});
