#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const scssImportWatcher = require("../index"); // This path should point to your scssImportWatcher.js file
const inquirer = require("inquirer").default;

// --- Global State ---
// watchers Map: Holds actively running watcher instances and their full configurations (including derived rootDir and stylesFile).
// This is primarily for managing the *live* watchers.
const watchers = new Map(); // key: name, value: { config: fullConfig, instance, isActive }

// watcherConfigs object: Holds the individual watcher configurations loaded from/saved to the JSON file.
// This is the source of truth for persistent watcher settings (watchDir, line, excludePaths).
let watcherConfigs = {}; // key: name, value: { name, watchDir, line, excludePaths }

// projectSettings object: Holds global project settings (rootDir, stylesFile) loaded from/saved to JSON.
let projectSettings = {}; // { rootDir: absolutePath, stylesFile: relativePath }

let _globalRootDir = null; // Stored as absolute path
let _globalStylesFile = null; // Stored as path relative to _globalRootDir

let configFileWatcher = null; // To hold the fs.FSWatcher instance for watchers.json
let saveTimeout = null; // For debouncing config file writes
const SAVE_DEBOUNCE_DELAY = 500; // milliseconds

// --- Helper Functions ---

// Function to get the full path to the watchers.json file
function getWatchersConfigPath() {
  if (!_globalRootDir) {
    // Fallback if _globalRootDir isn't set yet (e.g., first run before prompt)
    // This is primarily for initial loading or when projectSettings are cleared.
    return path.join(process.cwd(), "scss-watcher-config.json");
  }
  return path.join(_globalRootDir, ".scss-watcher", "config.json");
}

function loadConfigs() {
  const configPath = getWatchersConfigPath();
  if (fs.existsSync(configPath)) {
    try {
      const rawConfig = fs.readFileSync(configPath, "utf8");
      const parsedConfig = JSON.parse(rawConfig);
      watcherConfigs = parsedConfig.watchers || {};
      projectSettings = parsedConfig.projectSettings || {};
      console.log(`Loaded configuration from: ${configPath}`);
    } catch (error) {
      console.error(`Error loading configuration from ${configPath}:`, error.message);
      watcherConfigs = {};
      projectSettings = {};
    }
  } else {
    console.log("No existing configuration found. Starting fresh.");
  }
}

function saveConfigs(clearWatchersOnly = false) {
  if (saveTimeout) {
    clearTimeout(saveTimeout);
  }
  saveTimeout = setTimeout(() => {
    const configPath = getWatchersConfigPath();
    const configDir = path.dirname(configPath);

    if (!fs.existsSync(configDir)) {
      fs.mkdirSync(configDir, { recursive: true });
    }

    const configToSave = {
      watchers: clearWatchersOnly ? {} : watcherConfigs, // If clearing, save empty watchers
      projectSettings: projectSettings,
    };

    try {
      fs.writeFileSync(configPath, JSON.stringify(configToSave, null, 2), "utf8");
      // console.log(`Configuration saved to: ${configPath}`); // Suppress for less verbosity
    } catch (error) {
      console.error(`Error saving configuration to ${configPath}:`, error.message);
    }
  }, SAVE_DEBOUNCE_DELAY);
}

// Helper to recursively check for SCSS files in a directory
function containsScssFiles(dir) {
  if (!fs.existsSync(dir)) return false;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".scss")) {
      return true;
    }
    if (entry.isDirectory()) {
      // Limited recursion depth for performance in CLI Browse
      // For a robust check, you might want a more controlled recursion or async approach
      // For now, this simple recursive check should be sufficient for typical project structures.
      if (containsScssFiles(fullPath)) {
        return true;
      }
    }
  }
  return false;
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

// Generic directory browser
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

    const { choice } = await inquirer.prompt([
      {
        type: "list",
        name: "choice",
        message: `${message}\nCurrent: ${current}\n${
            isValidDir
                ? "🟢 Current path is a valid directory."
                : "🔴 Current path is NOT a valid directory."
        }\nSelect an action:`,
        choices: [
          { name: "✅ Use this directory", value: "use" },
          { name: "⬆️ Go up one level", value: "up" },
          new inquirer.Separator(),
          ...listFoldersAndFiles(current).folders.map((f) => ({
            name: f,
            value: f.substring(2), // Remove emoji for value
          })),
          { name: "✏️ Enter path manually", value: "manual" },
          { name: "⬅️ Back (Cancel)", value: "back" } // Added back/cancel option
        ],
      },
    ]);

    if (choice === "use") {
      let isFinalSelectionValid = isValidDir;
      if (isFinalSelectionValid && (message.includes("root directory") || message.includes("directory to watch"))) {
        // For root and watch directories, validate that they contain SCSS files
        if (!containsScssFiles(current)) {
          console.log("🚫 The selected directory or its subdirectories must contain at least one .scss file.");
          isFinalSelectionValid = false;
        }
      }

      if (isFinalSelectionValid) {
        return current;
      } else {
        console.log("🚫 Please choose a valid directory or enter manually.");
        current = await inquirer.prompt({
          type: "input",
          name: "path",
          message: "Enter the path manually:",
          default: current,
          validate: (input) => {
            const trimmedInput = input.trim();
            if (!fs.existsSync(trimmedInput)) {
              return "Directory does not exist.";
            }
            if (!fs.lstatSync(trimmedInput).isDirectory()) {
              return "Path is not a directory.";
            }
            if (message.includes("root directory") || message.includes("directory to watch")) {
              if (!containsScssFiles(trimmedInput)) {
                return "The selected directory or its subdirectories must contain at least one .scss file.";
              }
            }
            return true;
          }
        }).then(ans => ans.path.trim()); // Trim immediately after getting input
        // Continue loop to re-validate manual entry
      }
    } else if (choice === "up") {
      const parent = path.dirname(current);
      if (parent === current) { // Root directory check
        console.log("🚫 Already at the root directory.");
      } else {
        current = parent;
      }
    } else if (choice === "manual") {
      const { manualPath } = await inquirer.prompt({
        type: "input",
        name: "manualPath",
        message: "Enter the directory path:",
        default: current,
        validate: (input) => {
          const trimmedInput = input.trim();
          if (!fs.existsSync(trimmedInput)) {
            return "Directory does not exist.";
          }
          if (!fs.lstatSync(trimmedInput).isDirectory()) {
            return "Path is not a directory.";
          }
          if (message.includes("root directory") || message.includes("directory to watch")) {
            if (!containsScssFiles(trimmedInput)) {
              return "The selected directory or its subdirectories must contain at least one .scss file.";
            }
          }
          return true;
        }
      });
      current = manualPath.trim(); // Trim manual path input
    } else if (choice === "back") {
      return null; // User chose to cancel/go back
    } else {
      // User selected a subfolder
      current = path.join(current, choice.trim()); // Trim choice before joining
    }
  }
}

// New helper function to list SCSS files
function listScssFilesInDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".scss"))
      .map(entry => `📄 ${entry.name}`) // Add file icon
      .sort();
}

// NEW FUNCTION: Helper to list NON-PARTIAL SCSS files directly in a directory
function listNonPartialScssFilesInDir(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
      .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith(".scss") && !entry.name.startsWith("_"))
      .map(entry => `📄 ${entry.name}`) // Add file icon
      .sort();
}


// Constants for the header flag markers
const FLAG_START_MARKER = '/* SCSS_WATCHER_SUMMARY_START */';
const FLAG_END_MARKER = '/* SCSS_WATCHER_SUMMARY_END */';

/**
 * Updates the header flag in a styles file with the list of associated watcher names.
 * This function will replace its own previously inserted block or prepend a new one.
 * @param {string} filePath - Absolute path to the styles.scss file.
 * @param {string[]} watcherNames - Array of watcher names associated with this file.
 */
async function updateStylesFileHeaderFlag(filePath, watcherNames) {
  if (!fs.existsSync(filePath)) {
    console.warn(`Warning: Styles file not found at ${filePath}. Cannot update header flag.`);
    return;
  }

  let content = fs.readFileSync(filePath, 'utf8');
  let lines = content.split(/\r?\n/);

  // Remove existing flag block if present
  let startIndex = -1;
  let endIndex = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].includes(FLAG_START_MARKER)) {
      startIndex = i;
    }
    if (lines[i].includes(FLAG_END_MARKER)) {
      endIndex = i;
      break; // Found the end marker, stop searching
    }
  }

  if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
    // Valid block found, remove it
    lines.splice(startIndex, endIndex - startIndex + 1);
  } else if (startIndex !== -1) {
    // Only start marker found (malformed block), remove from start marker onwards
    lines.splice(startIndex);
  } else if (endIndex !== -1) {
    // Only end marker found (malformed block), remove up to end marker
    lines.splice(0, endIndex + 1);
  }

  let newFlagLines = [];
  if (watcherNames.length > 0) {
    const sortedNames = watcherNames.sort();
    newFlagLines.push(FLAG_START_MARKER);
    newFlagLines.push(`/* Watchers for this file: [${sortedNames.join(', ')}] */`);
    newFlagLines.push(FLAG_END_MARKER);
    // Add a blank line after the flag block if there's existing content following it
    if (lines.length > 0 && lines[0].trim().length > 0) {
      newFlagLines.push('');
    }
  } else {
    // If no watchers for this file, the block will simply be removed and not re-added.
  }

  // Prepend the new flag lines to the content
  lines.splice(0, 0, ...newFlagLines);

  // Normalize multiple blank lines in the entire file after insertion to at most two
  const finalContent = lines.join('\n').replace(/\n{3,}/g, '\n\n');

  try {
    fs.writeFileSync(filePath, finalContent, 'utf8');
    // console.log(`Updated header flag in ${path.basename(filePath)}.`); // Too verbose, log only for errors
  } catch (error) {
    console.error(`❌ Error updating header flag in ${path.basename(filePath)}:`, error.message);
  }
}

/**
 * Gathers all unique styles files from active watchers and their associated watcher names.
 * @returns {Map<string, Set<string>>} A map where key is absolute styles file path and value is a Set of watcher names.
 */
function getStylesFileToWatcherMap() {
  const map = new Map();
  watchers.forEach(watcherData => {
    const absStylesFilePath = path.resolve(watcherData.config.rootDir, watcherData.config.stylesFile);
    if (!map.has(absStylesFilePath)) {
      map.set(absStylesFilePath, new Set());
    }
    map.get(absStylesFilePath).add(watcherData.config.label); // Using label as watcher name for the flag
  });
  return map;
}

/**
 * Refreshes the header flags for all styles files managed by active watchers.
 */
async function refreshAllStylesFileFlags() {
  const stylesFileMap = getStylesFileToWatcherMap();

  // If _globalRootDir and _globalStylesFile are set, ensure that main styles file is
  // also considered for flag update, even if no active watcher currently targets it
  // (e.g., after all watchers are deleted, or before any are created).
  if (_globalRootDir && _globalStylesFile) {
    const globalAbsStylesFile = path.resolve(_globalRootDir, _globalStylesFile);
    if (!stylesFileMap.has(globalAbsStylesFile)) {
      stylesFileMap.set(globalAbsStylesFile, new Set()); // Add it to ensure its flag can be cleared
    }
  }

  for (const [filePath, watcherNamesSet] of stylesFileMap.entries()) {
    await updateStylesFileHeaderFlag(filePath, Array.from(watcherNamesSet));
  }
}

// --- NEW/Refactored Helper Functions for Project Settings ---

/**
 * Handles the flow for setting or editing the project's root directory.
 * @returns {boolean} True if root directory was successfully set/confirmed, false if cancelled.
 */
async function setRootDirFlow() {
  const newRootDir = await browseForDirectory(
      _globalRootDir || process.cwd(),
      "Select your project's new root directory:"
  );

  if (!newRootDir) { // User cancelled Browse
    console.log("Root directory selection cancelled.");
    return false;
  }

  if (newRootDir !== _globalRootDir) {
    // Only ask for confirmation if there are existing watchers that would be affected
    if (watchers.size > 0) {
      const { confirmChange } = await inquirer.prompt({
        type: "confirm",
        name: "confirmChange",
        message: "Changing the root directory will delete ALL existing watchers as their paths will become invalid. Are you sure?",
        default: false,
      });

      if (!confirmChange) {
        console.log("Root directory change cancelled.");
        return false;
      }
    }

    // Delete all existing watchers and clean up their imports
    const allWatcherNames = Array.from(watchers.keys());
    for (const name of allWatcherNames) {
      const watcherData = watchers.get(name);
      if (watcherData && watcherData.instance) {
        watcherData.instance.removeMarkers(true); // Remove markers and contents
        watcherData.instance.close();
      }
      watchers.delete(name);
      delete watcherConfigs[name]; // Also remove from persistent config
      console.log(`🗑️ Watcher "${name}" deleted due to root directory change.`);
    }

    _globalRootDir = newRootDir;
    _globalStylesFile = null; // Reset global styles file as it's relative to the root dir

    projectSettings.rootDir = _globalRootDir;
    projectSettings.stylesFile = _globalStylesFile; // Clear it in settings too
    saveConfigs();

    await refreshAllStylesFileFlags();
    console.log(`✅ Root directory updated to: ${_globalRootDir}`);
    console.log("Please re-set your Global Styles File and create new watchers if needed.");
    return true;
  } else {
    console.log("Root directory not changed. It's already set to the selected path.");
    return true;
  }
}

/**
 * Handles the flow for setting or editing the global styles file.
 * Requires _globalRootDir to be set.
 * @returns {boolean} True if global styles file was successfully set/confirmed, false if cancelled.
 */
async function setGlobalStylesFileFlow() {
  if (!_globalRootDir) {
    console.log("🚫 Please set the Root Directory first.");
    return false;
  }

  // Get non-partial SCSS files directly in root
  const directScssFiles = listNonPartialScssFilesInDir(_globalRootDir);

  let choices = [];
  if (directScssFiles.length > 0) {
    choices.push(new inquirer.Separator('Available SCSS Files in Root:'));
    choices.push(...directScssFiles.map(f => ({ name: f, value: f.substring(2) })));
  } else {
    choices.push({ name: "No non-partial SCSS files found directly in the root directory.", value: "no_files", disabled: true });
  }

  choices.push(new inquirer.Separator());
  choices.push({ name: "✏️ Enter file path manually (must be in root, non-partial .scss)", value: "manual" });
  choices.push({ name: "⬅️ Cancel Global Styles File Setup", value: "cancel" });


  const { selectedFile } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedFile",
      message: `Select your main SCSS file (must be a non-partial .scss file directly in the root directory):\nRoot: ${_globalRootDir}`,
      choices: choices,
    },
  ]);

  let newStylesFileAbsolute = null;

  if (selectedFile === "cancel") {
    console.log("Global Styles File selection cancelled.");
    return false;
  } else if (selectedFile === "manual") {
    const { manualPath } = await inquirer.prompt({
      type: "input",
      name: "manualPath",
      message: "Enter the SCSS file path (e.g., 'style.scss', 'main.scss') relative to root directory:",
      validate: (input) => {
        const trimmedInput = input.trim();
        const absPath = path.resolve(_globalRootDir, trimmedInput);

        if (!absPath.startsWith(_globalRootDir) || path.dirname(absPath) !== _globalRootDir) {
          return "File must be directly in the project root directory.";
        }
        if (!fs.existsSync(absPath)) {
          return "File does not exist.";
        }
        if (!fs.lstatSync(absPath).isFile()) {
          return "Path is not a file.";
        }
        if (!trimmedInput.toLowerCase().endsWith(".scss")) {
          return "File must have a .scss extension.";
        }
        if (path.basename(trimmedInput).startsWith("_")) {
          return "File cannot be a partial (cannot start with '_').";
        }
        return true;
      }
    });
    newStylesFileAbsolute = path.resolve(_globalRootDir, manualPath.trim());
  } else {
    // User selected from the list
    newStylesFileAbsolute = path.resolve(_globalRootDir, selectedFile);
  }

  let newStylesFileRelative = path.relative(_globalRootDir, newStylesFileAbsolute);

  if (newStylesFileRelative !== _globalStylesFile) {
    if (watchers.size > 0) {
      const { confirmChange } = await inquirer.prompt({
        type: "confirm",
        name: "confirmChange",
        message: "Changing the global styles file will restart all existing watchers to update their target file. Continue?",
        default: false,
      });

      if (!confirmChange) {
        console.log("Global Styles File change cancelled.");
        return false;
      }
    }

    const oldStylesFileAbsolutePath = _globalRootDir && _globalStylesFile ? path.resolve(_globalRootDir, _globalStylesFile) : null;
    _globalStylesFile = newStylesFileRelative;
    projectSettings.stylesFile = _globalStylesFile;
    saveConfigs();

    const watchersToRestart = Array.from(watchers.keys());
    for (const name of watchersToRestart) {
      const watcherData = watchers.get(name);
      if (watcherData && watcherData.instance) {
        watcherData.instance.close();
        console.log(`Restarting watcher "${name}" with new styles file...`);
        const newConfig = {
          ...watcherData.config,
          stylesFile: _globalStylesFile,
        };
        const newInstance = scssImportWatcher(newConfig);
        newInstance._initialUpdate();
        watchers.set(name, { ...watcherData, config: newConfig, instance: newInstance });
      }
    }

    if (oldStylesFileAbsolutePath && oldStylesFileAbsolutePath !== path.resolve(_globalRootDir, _globalStylesFile)) {
      try {
        await updateStylesFileHeaderFlag(oldStylesFileAbsolutePath, []);
        console.log(`Cleaned up old styles file: ${path.basename(oldStylesFileAbsolutePath)}`);
      } catch (error) {
        console.error(`Error cleaning old styles file ${path.basename(oldStylesFileAbsolutePath)}: ${error.message}`);
      }
    }

    await refreshAllStylesFileFlags();
    console.log(`✅ Global Styles File updated to: ${_globalStylesFile}`);
    return true;
  } else {
    console.log("Global Styles File not changed. It's already set to the selected path.");
    return true;
  }
}


// --- Project Setup Flow ---
async function projectSettingsFlow() {
  console.log("\n--- Project Setup ---");

  // 1. Ask for Root Directory
  const rootDirSet = await setRootDirFlow();
  if (!rootDirSet) {
    console.log("Project setup cancelled during Root Directory selection. Exiting.");
    process.exit(0);
  }

  // 2. Ask for Global Styles File
  const stylesFileSet = await setGlobalStylesFileFlow(); // This needs to be modified for the new constraints
  if (!stylesFileSet) {
    console.log("Project setup cancelled during Global Styles File selection. Exiting.");
    process.exit(0);
  }

  // 3. Show settings and ask to continue
  console.log("\n--- Project Settings Summary ---");
  console.log(`📁 Root Directory: ${_globalRootDir}`);
  console.log(`📄 Global Styles File: ${path.join(path.basename(_globalRootDir), _globalStylesFile)}`);

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

  console.log("Project setup complete. Loading watchers...");
}


// --- Main CLI Flows ---

async function createWatcherFlow() {
  console.log("\n--- Create New Watcher ---");

  // These are now guaranteed to be set by projectSettingsFlow
  if (!_globalRootDir || !_globalStylesFile) {
    console.error("🚫 Error: Root Directory or Global Styles File not set. Please set them in Project Settings first.");
    return; // Just return, let the main menu loop handle continuing
  }

  // 1. Select the directory to watch
  const watchDirAbsolute = await browseForDirectory(
      _globalRootDir, // Always start watchDir Browse from the root
      "Select the directory to watch for SCSS files:"
  );
  // If user cancelled or an error occurred during watch dir selection
  if (!watchDirAbsolute) {
    console.log("Watch directory not set. Cannot create watcher.");
    return; // Just return, let the main menu loop handle continuing
  }
  const watchDirRelative = path.relative(_globalRootDir, watchDirAbsolute);
  const defaultWatcherName = path.basename(watchDirAbsolute); // Default name based on folder name

  // 2. Ask for watcher name, defaulting to folder name
  const { name } = await inquirer.prompt([
    {
      type: "input",
      name: "name",
      message: "Enter a unique name for this watcher:",
      default: defaultWatcherName, // Set default to the selected folder's name
      validate: (input) =>
          input.trim() !== "" && !watchers.has(input)
              ? true
              : "Watcher name must be unique and not empty.",
    },
  ]);

  // 3. Ask for the line number
  const { line } = await inquirer.prompt([
    {
      type: "input",
      name: "line",
      message: "Enter the 1-indexed line number in your main SCSS file where imports should be added:",
      validate: (input) =>
          /^\d+$/.test(input) && parseInt(input) >= 1
              ? true
              : "Please enter a valid positive integer.",
      default: 1,
    },
  ]);

  // Removed the 'addExclusions' prompt and related logic
  let excludePaths = []; // Always initialize as empty array

  const config = {
    rootDir: _globalRootDir, // Will always be _globalRootDir (absolute)
    watchDir: watchDirRelative, // Stored as relative
    stylesFile: _globalStylesFile, // Will always be _globalStylesFile (relative)
    label: name,
    markerId: name,
    line: parseInt(line),
    excludePaths: excludePaths, // Will be empty
  };

  try {
    const instance = scssImportWatcher(config);
    instance._initialUpdate(); // Initial generation and update
    watchers.set(name, { config, instance, isActive: true }); // Store config, instance, and active state
    watcherConfigs[name] = { // Save simplified config for persistence
      name: name,
      watchDir: watchDirRelative,
      line: parseInt(line),
      excludePaths: excludePaths,
    };
    saveConfigs(); // Save updated watcherConfigs and projectSettings

    console.log(`✨ Watcher "${name}" created and started.`);
    await refreshAllStylesFileFlags(); // Update header flag
  } catch (error) {
    console.error(`❌ Failed to create watcher "${name}":`, error.message);
  }

  // Removed the "Press Enter to continue..." prompt as requested.
}

async function showWatchersFlow() {
  console.log("\n--- Current Watchers ---");
  if (watchers.size === 0) {
    console.log("No watchers currently configured.");
  } else {
    watchers.forEach((watcherData, name) => {
      console.log(`\nName: ${name}`);
      console.log(`Status: ${watcherData.isActive ? '✅ Running' : '⏸️ Paused'}`);
      console.log(`  Root Dir: ${watcherData.config.rootDir}`);
      console.log(`  Watch Dir: ${watcherData.config.watchDir}`);
      console.log(`  Styles File: ${watcherData.config.stylesFile}`);
      console.log(`  Insert Line: ${watcherData.config.line}`);
      if (watcherData.config.excludePaths && watcherData.config.excludePaths.length > 0) {
        console.log(`  Excluded Paths:`);
        watcherData.config.excludePaths.forEach(p => console.log(`    - ${p}`));
      }
    });
  }
  await inquirer.prompt({
    type: "input",
    name: "continue",
    message: "Press Enter to continue...",
  });
}

async function deleteWatcherFlow(watcherNameToDelete = null) {
  if (watchers.size === 0) {
    console.log("No watchers to delete.");
    if (watcherNameToDelete === null) { // Only prompt if not called from exit flow
      await inquirer.prompt({
        type: "input",
        name: "continue",
        message: "Press Enter to continue...",
      });
    }
    return;
  }

  let selectedWatchers = [];
  if (watcherNameToDelete) {
    selectedWatchers.push(watcherNameToDelete);
  } else {
    const choices = Array.from(watchers.keys()).map((name) => ({ name }));
    const { watchersToDelete } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "watchersToDelete",
        message: "Select watcher(s) to delete:",
        choices: choices,
        validate: (input) =>
            input.length > 0 ? true : "Please select at least one watcher.",
      },
    ]);
    selectedWatchers = watchersToDelete;
  }

  for (const name of selectedWatchers) {
    const watcherData = watchers.get(name);
    if (watcherData) {
      if (watcherData.instance) {
        watcherData.instance.removeMarkers(true); // true to delete imports too
        watcherData.instance.close();
      }
      watchers.delete(name);
      delete watcherConfigs[name]; // Remove from persistent config
      console.log(`🗑️ Watcher "${name}" deleted.`);
    }
  }

  saveConfigs(); // Save updated watcherConfigs
  await refreshAllStylesFileFlags(); // Update header flag

  if (watcherNameToDelete === null) { // Only prompt if not called from exit flow
    await inquirer.prompt({
      type: "input",
      name: "continue",
      message: "Press Enter to continue...",
    });
  }
}

// Stop/Resume Watchers Flow
async function stopWatchersFlow() {
  if (watchers.size === 0) {
    console.log("No watchers running.");
    await inquirer.prompt({
      type: "input",
      name: "continue",
      message: "Press Enter to continue...",
    });
    return;
  }

  const choices = Array.from(watchers.entries()).map(([name, watcherData]) => ({
    name: `${watcherData.isActive ? '✅ Running' : '⏸️ Paused'} - ${name} (${watcherData.config.watchDir})`,
    value: name,
    short: name
  }));

  const { selectedWatchers } = await inquirer.prompt([
    {
      type: "checkbox",
      name: "selectedWatchers",
      message: "Select watchers to toggle pause/resume:",
      choices: choices,
      validate: (input) =>
          input.length > 0 ? true : "Please select at least one watcher.",
    },
  ]);

  for (const name of selectedWatchers) {
    const watcherData = watchers.get(name);
    if (watcherData && watcherData.instance) {
      if (watcherData.isActive) {
        watcherData.instance.pause();
        watcherData.isActive = false; // Update internal state in Map
        console.log(`Watcher "${name}" paused.`);
      } else {
        watcherData.instance.resume();
        watcherData.isActive = true; // Update internal state in Map
        console.log(`Watcher "${name}" resumed.`);
      }
    }
  }
  await refreshAllStylesFileFlags(); // Update header flag

  await inquirer.prompt({
    type: "input",
    name: "continue",
    message: "Press Enter to continue...",
  });
}

// General Settings Flow (now delegates to setRootDirFlow/setGlobalStylesFileFlow)
async function generalSettingsFlow() {
  console.log("\n--- General Settings ---");

  while (true) {
    const { settingAction } = await inquirer.prompt([
      {
        type: "list",
        name: "settingAction",
        message: "Manage your project's root directory and global styles file:",
        choices: [
          { name: "Set Root Directory", value: "set_root_dir" },
          { name: "Set Global Styles File", value: "set_styles_file" },
          { name: "⬅️ Back to Main Menu", value: "back" },
        ],
      },
    ]);

    if (settingAction === "set_root_dir") {
      await setRootDirFlow(); // Calls the shared flow
    } else if (settingAction === "set_styles_file") {
      await setGlobalStylesFileFlow(); // Calls the shared flow
    } else if (settingAction === "back") {
      break;
    }
    // Only prompt to continue if we didn't go back to main menu
    if (settingAction !== "back") {
      await inquirer.prompt({ type: "input", name: "c", message: "Press Enter to continue..." });
    }
  }
}


// Main menu loop
async function mainMenu() {
  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "Main menu:",
        choices: [
          { name: "➕ Create new watcher", value: "create" },
          { name: "⏸️ Stop/Resume watchers", value: "toggle_pause" },
          { name: "👀 Show watchers", value: "show" },
          { name: "🗑️ Delete watcher(s)", value: "delete" },
          { name: "⚙️ General Settings", value: "settings" },
          { name: "🚪 Exit", value: "exit" },
        ],
      },
    ]);

    if (action === "create") {
      await createWatcherFlow();
    } else if (action === "toggle_pause") {
      await stopWatchersFlow();
    } else if (action === "show") {
      await showWatchersFlow();
    } else if (action === "delete") {
      await deleteWatcherFlow(null);
    } else if (action === "settings") {
      await generalSettingsFlow();
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
        const allFilesToCleanOnExit = new Set();
        // Add the global styles file for a final cleanup of its flag
        if (_globalRootDir && _globalStylesFile) {
          allFilesToCleanOnExit.add(path.resolve(_globalRootDir, _globalStylesFile));
        }

        for (const [name, { config, instance }] of watchers) {
          if (instance) {
            instance.removeMarkers(true); // Always remove markers on exit
            instance.close(); // Close the chokidar watcher instance
          }
          // Also add any other styles files used by specific watchers if the system supported multiple
          // For now, it's just the global one.
        }
        watchers.clear();
        watcherConfigs = {}; // Clear persistent configs
        saveConfigs(true); // Save empty watchers, but keep project settings

        // NEW: Update header flags one last time to clear them on exit
        await refreshAllStylesFileFlags();

        // Perform a final cleanup for all affected styles files (normalize blank lines)
        for (const filePath of allFilesToCleanOnExit) {
          try {
            let content = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : '';
            // Consolidate blank lines to prevent excessive newlines
            const finalContent = content.replace(/\n{3,}/g, "\n\n");
            fs.writeFileSync(filePath, finalContent, "utf8");
          } catch (err) {
            console.error(`❌ Error cleaning up ${path.basename(filePath)}: ${err.message}`);
          }
        }

        console.log("👋 Exiting. All watchers stopped and imports cleaned up.");
        process.exit(0);
      }
    }
  }
}

// Initial setup and start of the CLI
async function startCli() {
  loadConfigs(); // This loads watcherConfigs and projectSettings

  // Initialize _globalRootDir and _globalStylesFile from loaded projectSettings
  if (projectSettings.rootDir) {
    _globalRootDir = projectSettings.rootDir;
    console.log(`Loaded Root Directory: ${_globalRootDir}`);
  }
  if (projectSettings.stylesFile) {
    _globalStylesFile = projectSettings.stylesFile;
    // Log styles file relative to root for clarity
    console.log(`Loaded Global Styles File: ${path.join(path.basename(_globalRootDir || ""), _globalStylesFile)}`);
  }

  // --- NEW: Project Setup Flow runs first ---
  await projectSettingsFlow();

  // If we reach here, project settings are confirmed or set by the user.
  // Now, restore watchers if they exist in watcherConfigs and root/styles are set
  if (_globalRootDir && _globalStylesFile) {
    let restoredCount = 0;
    for (const name in watcherConfigs) {
      const configFromSaved = watcherConfigs[name];
      // Ensure config uses global rootDir and stylesFile from current settings
      const fullConfig = {
        ...configFromSaved, // This contains name, watchDir (relative), line, excludePaths
        rootDir: _globalRootDir, // Override rootDir to be current global one
        stylesFile: _globalStylesFile, // Override stylesFile to be current global one
        label: name,
        markerId: name,
      };
      try {
        const instance = scssImportWatcher(fullConfig);
        instance._initialUpdate(); // Initial update
        watchers.set(name, { config: fullConfig, instance, isActive: true });
        console.log(`✨ Restored watcher "${name}".`);
        restoredCount++;
      } catch (error) {
        console.error(`❌ Failed to restore watcher "${name}": ${error.message}`);
        // Remove invalid watcher from persistent config if it failed to restore
        delete watcherConfigs[name];
        saveConfigs(); // Save immediately to reflect removal
      }
    }
    if (restoredCount > 0) {
      await refreshAllStylesFileFlags(); // Update header flags after restoring watchers
    }
  } else {
    // This block should ideally not be reached if projectSettingsFlow ensures values are set.
    console.log("\nProject settings are still incomplete. Please try setting them again in General Settings if you wish to proceed.");
  }

  // Finally, enter the main menu
  mainMenu();
}

// Start the CLI application
startCli();