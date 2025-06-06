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
let saveTimeout = null; // For debouncing config file writes
const SAVE_DEBOUNCE_DELAY = 500; // milliseconds

// --- Helper Functions ---

// Function to get the full path to the watchers.json file
function getWatchersConfigPath() {
  if (!_globalRootDir) {
    // Fallback if _globalRootDir isn't set yet (e.g., first run before prompt)
    return path.join(process.cwd(), "watchers.json");
  }
  return path.join(_globalRootDir, "watchers.json");
}

// Function to save configurations to file
function saveConfigs(clearWatchers = false) {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    try {
      const configToSave = {
        _globalRootDir: _globalRootDir,
        _globalStylesFile: _globalStylesFile,
        watchers: clearWatchers ? {} : watcherConfigs, // Clear if requested
      };
      const configPath = getWatchersConfigPath();
      fs.writeFileSync(configPath, JSON.stringify(configToSave, null, 2), "utf8");
      // console.log(`Configs saved to ${configPath}`); // Removed for less clutter
    } catch (error) {
      console.error(`\n❌ Error saving configuration: ${error.message}`);
    }
  }, SAVE_DEBOUNCE_DELAY);
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

      // Start watching the config file itself for external changes
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
  if (configFileWatcher) {
    configFileWatcher.close(); // Close existing watcher if any
  }
  const configPath = getWatchersConfigPath();
  if (!fs.existsSync(configPath)) {
    // If config file doesn't exist yet, we can't watch it. It's created on save.
    return;
  }

  configFileWatcher = chokidar.watch(configPath, {
    persistent: true,
    ignoreInitial: true,
    depth: 0, // Only watch the file itself
  });

  configFileWatcher.on('change', () => {
    console.log(`\n🔄 Config file ${path.basename(configPath)} changed externally. Reloading watchers...`);
    handleExternalConfigChange();
  });
  configFileWatcher.on('error', (error) => {
    console.error(`\n❌ Error watching config file: ${error.message}`);
  });
}

// Function to handle external config file changes
async function handleExternalConfigChange() {
  // Stop all current watchers
  for (const [name, { instance }] of watchers) {
    if (instance) {
      instance.close();
    }
  }
  watchers.clear(); // Clear the map of active watchers

  // Reload configurations
  loadConfigs(); // This will update _globalRootDir, _globalStylesFile, watcherConfigs

  // Re-initialize all watchers based on the reloaded config
  for (const name in watcherConfigs) {
    await loadAndInitializeWatcher(name); // Use await here
  }
  console.log("✅ Watchers reloaded and reinitialized.");
  // No need to call mainMenu here, it's called after initial load.
  // The program will just continue its loop.
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
    // Return empty arrays on error, so inquirer doesn't crash on ENOENT
    return { folders: [] };
  }
}

// NEW FUNCTION: Generic directory browser
async function browseForDirectory(startDir, message, isRootRestricted = false) { // Added isRootRestricted
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

    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: message,
        choices: [
          {
            name: `(Current: ${isValidDir ? current : "Invalid Path"})`,
            value: "current",
            disabled: true,
          },
          ...listFoldersAndFiles(current).folders,
          new inquirer.Separator(),
          {
            name: "⬆️ Go up a directory",
            value: "up",
            // Disable if we are at the global root and restricted, or at the system root
            disabled: isRootRestricted ? (current === _globalRootDir) : (current === path.parse(current).root)
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
      // Logic for handling 'up' should rely on the 'disabled' property,
      // but also ensure we don't accidentally go above _globalRootDir if restricted
      if (isRootRestricted && current === _globalRootDir) {
        continue; // Should be disabled, but defensive check
      }
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

// NEW FUNCTION: Browse for a single SCSS file in a given directory (no traversal)
async function browseForScssFile(searchDir, message) {
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
    console.log(`\n⚠️ No .scss files found in ${searchDir}.`);
    const { retry } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'retry',
        message: 'Do you want to select a different root directory to search for SCSS files?',
        default: true,
      },
    ]);
    if (retry) {
      return 'RESELECT_ROOT'; // Special signal to restart root selection
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

  // Ensure rootDir and stylesFile are always absolute paths
  const fullConfig = {
    ...config,
    rootDir: _globalRootDir, // This is always absolute from loadConfigs
    stylesFile: _globalStylesFile, // This is relative to _globalRootDir
    // NEW: Pass the entire watcherConfigs for cross-watcher filtering
    allWatchersConfigs: watcherConfigs
  };

  try {
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

// Initial setup for _globalRootDir and _globalStylesFile (Moved to top level)
async function setupProjectRootAndStylesFile() {
  console.log("\n--- Initial Project Setup ---");
  console.log("This tool needs to know your main project root and where your primary SCSS file is located.");

  let currentDir = process.cwd(); // Start Browse from current working directory
  let rootDirSelected = false;
  let stylesFileSelected = false;

  while (!rootDirSelected) {
    const rootDirAbsolute = await browseForDirectory(
        currentDir,
        "Select your main project root directory (where watchers.json will be stored, e.g., your project's package.json directory):"
    );
    if (!rootDirAbsolute) {
      console.log("Project root selection cancelled. Cannot proceed.");
      return; // Exit if user cancels
    }
    _globalRootDir = rootDirAbsolute;
    rootDirSelected = true;
  }

  while (!stylesFileSelected) {
    console.log(`\nNow, select your primary SCSS file (e.g., main.scss, app.scss) from: ${_globalRootDir}`);
    const stylesFileAbsolute = await browseForScssFile(
        _globalRootDir, // Pass the global root dir directly
        "Select your main SCSS file to be updated:"
    );

    if (stylesFileAbsolute === 'RESELECT_ROOT') {
      // User wants to reselect root because no SCSS files were found
      _globalRootDir = null; // Reset root to re-trigger root selection loop
      rootDirSelected = false; // Go back to root selection
      continue; // Restart the outer while loop
    }
    if (!stylesFileAbsolute) {
      console.log("Main SCSS file selection cancelled. Cannot proceed.");
      _globalRootDir = null; // Reset if styles file not selected
      return; // Exit if user cancels
    }
    _globalStylesFile = path.relative(_globalRootDir, stylesFileAbsolute);
    if (!_globalStylesFile.endsWith('.scss')) {
      console.warn("⚠️ Warning: The selected file does not have a .scss extension. Ensure it's a valid SCSS file.");
    }
    stylesFileSelected = true;
  }

  // Save the initial project settings
  saveConfigs();
  console.log(`\n--- Project Settings Summary ---`);
  console.log(`📁 Project Root Set: ${_globalRootDir}`);
  console.log(`📄 Global Styles File Set: ${path.join(path.basename(_globalRootDir), _globalStylesFile)}`);

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
      true // isRootRestricted = true
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

        // Re-initialize the parent watcher to apply the new excludePaths
        // This will also trigger removeMarkers(true) on the old instance and then regenerate imports
        const existingInstance = watchers.get(existingWatcherName)?.instance;
        if (existingInstance) {
          console.log(`Cleaning up old markers for "${existingWatcherName}"...`);
          existingInstance.removeMarkers(true); // Clean up old markers AND their content
          existingInstance.close(); // Close old watcher instance
          watchers.delete(existingWatcherName); // Remove old instance from map
        }
        await loadAndInitializeWatcher(existingWatcherName); // Load and initialize with new config
      }
    }
  }
  // --- END NEW LOGIC ---

  saveConfigs(); // Save the updated configurations (including any changes to parent watchers)
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

  // Prompt for new watchDir
  const currentWatchDirAbsolute = path.resolve(_globalRootDir, config.watchDir);
  const newWatchDirAbsolute = await browseForDirectory(
      currentWatchDirAbsolute,
      `Select new watch directory (current: ${config.watchDir}):`,
      true // isRootRestricted = true
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

  // Store the old watchDir before updating for comparison later
  const oldWatchDirRelative = config.watchDir;

  // Update configuration object
  config.watchDir = newWatchDirRelative;
  config.line = newLine;
  config.markerId = newMarkerId;
  config.excludePaths = newExcludePaths;

  // Save the updated configuration to disk
  saveConfigs();
  console.log(`\n✅ Watcher "${watcherName}" configuration updated.`);

  // If the watch directory changed, we might need to re-evaluate exclusions for other watchers
  if (oldWatchDirRelative !== newWatchDirRelative) {
    console.log(`\nWatch directory for "${watcherName}" changed. Re-evaluating exclusions for all watchers...`);
    // Re-evaluate and re-initialize all watchers to update their exclusion lists
    for (const nameOfOtherWatcher in watcherConfigs) {
      const otherWatcherConfig = watcherConfigs[nameOfOtherWatcher];
      const otherWatcherWatchDirAbsolute = path.resolve(_globalRootDir, otherWatcherConfig.watchDir);

      // Check if this other watcher is a parent of the *new* watchDir
      const relativePathFromOtherToNew = path.relative(otherWatcherWatchDirAbsolute, newWatchDirAbsolute);
      const isOtherParentOfNew = !relativePathFromOtherToNew.startsWith('..') && relativePathFromOtherToNew !== '';

      // Check if this other watcher was a parent of the *old* watchDir
      const relativePathFromOtherToOld = path.relative(otherWatcherWatchDirAbsolute, path.resolve(_globalRootDir, oldWatchDirRelative));
      const isOtherParentOfOld = !relativePathFromOtherToOld.startsWith('..') && relativePathFromOtherToOld !== '';

      let shouldUpdateOtherWatcher = false;
      const updatedExcludePathsSet = new Set(otherWatcherConfig.excludePaths);

      if (isOtherParentOfNew) {
        // If other watcher is now a parent of the new watchDir, ensure the new watchDir is excluded
        if (!updatedExcludePathsSet.has(newWatchDirRelative)) {
          updatedExcludePathsSet.add(newWatchDirRelative);
          shouldUpdateOtherWatcher = true;
          console.log(`Adding "${newWatchDirRelative}" to excludePaths of "${nameOfOtherWatcher}".`);
        }
      } else {
        // If other watcher is NOT a parent of the new watchDir, ensure the new watchDir is NOT excluded
        if (updatedExcludePathsSet.has(newWatchDirRelative)) {
          updatedExcludePathsSet.delete(newWatchDirRelative);
          shouldUpdateOtherWatcher = true;
          console.log(`Removing "${newWatchDirRelative}" from excludePaths of "${nameOfOtherWatcher}".`);
        }
      }

      // Also handle removal of old path if it was a child and is no longer
      if (isOtherParentOfOld && oldWatchDirRelative !== newWatchDirRelative) {
        if (updatedExcludePathsSet.has(oldWatchDirRelative)) {
          updatedExcludePathsSet.delete(oldWatchDirRelative);
          shouldUpdateOtherWatcher = true;
          console.log(`Removing old watchDir "${oldWatchDirRelative}" from excludePaths of "${nameOfOtherWatcher}".`);
        }
      }


      if (shouldUpdateOtherWatcher) {
        otherWatcherConfig.excludePaths = Array.from(updatedExcludePathsSet);
        // Re-initialize the other watcher to apply its updated excludePaths
        const otherWatcherInstance = watchers.get(nameOfOtherWatcher)?.instance;
        if (otherWatcherInstance) {
          console.log(`Cleaning up old markers for "${nameOfOtherWatcher}"...`);
          otherWatcherInstance.removeMarkers(true);
          otherWatcherInstance.close();
          watchers.delete(nameOfOtherWatcher);
        }
        await loadAndInitializeWatcher(nameOfOtherWatcher);
      }
    }
  }


  // Re-initialize the watcher instance with new config
  const existingInstance = watchers.get(watcherName)?.instance;
  if (existingInstance) {
    console.log(`\nCleaning up old markers for "${watcherName}"...`);
    existingInstance.removeMarkers(true); // Clean up old markers AND their content
    existingInstance.close(); // Close old watcher instance
    watchers.delete(watcherName); // Remove old instance from map
  }

  // Load and initialize the watcher with the new configuration
  await loadAndInitializeWatcher(watcherName);

  console.log(`\nWatcher "${watcherName}" reinitialized with new settings.`);
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
        watcherData.instance.removeMarkers(true); // Remove markers AND their contents
        watcherData.instance.close(); // Close the watcher instance
      }
      watchers.delete(name); // Remove from active watchers map
      delete watcherConfigs[name]; // Remove from persistent config
      console.log(`\n🗑️ Watcher "${name}" deleted and imports cleaned up.`);

      // --- NEW LOGIC: Remove deleted watcher's path from other watchers' excludePaths ---
      const deletedWatcherRelativeWatchDir = watcherConfigs[name] && watcherConfigs[name].watchDir;
      if (deletedWatcherRelativeWatchDir) {
        for (const otherWatcherName in watcherConfigs) {
          const otherWatcherConfig = watcherConfigs[otherWatcherName];
          const updatedExcludePaths = new Set(otherWatcherConfig.excludePaths);
          if (updatedExcludePaths.has(deletedWatcherRelativeWatchDir)) {
            updatedExcludePaths.delete(deletedWatcherRelativeWatchDir);
            otherWatcherConfig.excludePaths = Array.from(updatedExcludePaths);
            console.log(`\n🔄 Removed "${deletedWatcherRelativeWatchDir}" from excludePaths of watcher "${otherWatcherName}".`);

            // Re-initialize the other watcher to apply the updated excludePaths
            const otherWatcherInstance = watchers.get(otherWatcherName)?.instance;
            if (otherWatcherInstance) {
              console.log(`Cleaning up old markers for "${otherWatcherName}"...`);
              otherWatcherInstance.removeMarkers(true);
              otherWatcherInstance.close();
              watchers.delete(otherWatcherName);
            }
            await loadAndInitializeWatcher(otherWatcherName);
          }
        }
      }
      // --- END NEW LOGIC ---
    }
    saveConfigs(); // Save updated configs to file
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
    const allMarkerIds = Object.keys(watcherConfigs).concat(
        Array.from(watchers.keys()) // Include names of currently active watchers too
    ).filter((value, index, self) => self.indexOf(value) === index); // Get unique IDs

    let cleanedLines = [];
    let insideMarkerBlock = false;
    let relevantMarkerFound = false; // Flag to track if any known marker was found

    // Helper to escape special characters in a string for use in a RegExp
    function escapeRegExp(string) {
      return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the matched substring
    }

    const startMarkerRegexes = allMarkerIds.map(id => new RegExp(`^/\\* ${escapeRegExp(id)} import start \\*/$`, 'm'));
    const endMarkerRegexes = allMarkerIds.map(id => new RegExp(`^/\\* ${escapeRegExp(id)} import end \\*/$`, 'm'));

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
              "Are you sure you want to exit? This will delete all watchers and clean up all their imports.",
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
