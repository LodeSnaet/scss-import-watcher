#!/usr/bin/env node

const path = require("path");
const fs = require("fs");
const scssImportWatcher = require("../index"); // This path should point to your scssImportWatcher.js file
const inquirer = require("inquirer").default;

const watchers = new Map(); // key: name, value: { config, instance }
let _globalRootDir = null; // Store the root directory once it's set

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

    if (!isValidDir) {
      console.log(
        `❌ Path not found or is not a directory: ${current}. Please navigate or select an existing folder.`,
      );
      // If the current path became invalid, try to go up one level
      if (current !== startDir) {
        current = path.dirname(current);
      } else {
        // If we are at the startDir and it's invalid, we need a way out
        console.log("Cannot navigate from an invalid starting point.");
        // This might need a more robust initial check in promptRootFolder
        return null; // Indicate failure to browse
      }
      continue; // Retry the loop with the (potentially) new current path
    }

    const { folders } = listFoldersAndFiles(current);

    let choices = [];
    const isFilesystemRoot = path.dirname(current) === current; // Check if it's the filesystem root (e.g., C:\, /)

    if (!isFilesystemRoot) {
      choices.push({ name: "↩️ .. (go up)", value: "__UP__" }); // Add back icon for 'go up'
    }

    if (folders.length > 0) {
      // Add subfolders, stripping the emoji for the value
      choices = choices.concat(
        folders.map((f) => ({ name: f, value: f.replace(/^📁\s*/, "") })),
      );
    } else {
      console.log("⚠️ No subfolders found in this directory.");
    }

    choices.push(new inquirer.Separator());
    choices.push({ name: "✅ Select this folder", value: "__SELECT_THIS_FOLDER__" });
    choices.push({ name: "❌ Cancel", value: "__CANCEL__" });

    const { selected } = await inquirer.prompt([
      {
        type: "list",
        name: "selected",
        message: `${message}\nCurrent path: ${path.relative(startDir, current) || "."}`,
        choices,
      },
    ]);

    if (selected === "__SELECT_THIS_FOLDER__") {
      return current; // Return the current path if selected
    } else if (selected === "__CANCEL__") {
      return null; // User cancelled
    } else if (selected === "__UP__") {
      current = path.dirname(current);
    } else {
      current = path.join(current, selected);
    }
  }
}

// MODIFIED: promptRootFolder to validate and offer Browse
async function promptRootFolder() {
  while (true) {
    const { method } = await inquirer.prompt([
      {
        type: "list",
        name: "method",
        message: "How do you want to set the project root folder?",
        choices: [
          { name: `✍️ Enter path (default: ${process.cwd()})`, value: "manual" },
          { name: "🔍 Browse from current directory", value: "browse" },
          { name: "🚪 Exit CLI", value: "exit" },
        ],
      },
    ]);

    if (method === "exit") {
      console.log("👋 Exiting CLI. Goodbye!");
      process.exit(0);
    }

    let selectedPath = null;
    if (method === "manual") {
      const { rootDirInput } = await inquirer.prompt([
        {
          type: "input",
          name: "rootDirInput",
          message: "Enter the root folder path:",
          default: process.cwd(),
        },
      ]);
      selectedPath = path.resolve(rootDirInput);
    } else if (method === "browse") {
      selectedPath = await browseForDirectory(
        process.cwd(), // Start Browse from where the CLI is run
        "Navigate to your project root folder:",
      );
      if (selectedPath === null) {
        // User cancelled Browse, go back to method selection
        console.log("Root folder selection cancelled. Please try again.");
        continue;
      }
    }

    // Validate the chosen/entered path
    try {
      const stats = fs.lstatSync(selectedPath);
      if (stats.isDirectory()) {
        return selectedPath; // Valid directory found
      } else {
        console.log(`❌ Path is not a directory: ${selectedPath}. Please select a folder.`);
      }
    } catch (error) {
      if (error.code === 'ENOENT') {
        console.log(`❌ Path not found: ${selectedPath}. Please try again.`);
      } else {
        console.log(`❌ Error validating path: ${error.message}. Please try again.`);
      }
    }
  }
}

// EXISTING: promptFolderTraversal (specific to selecting watch subfolders within _globalRootDir)
async function promptFolderTraversal(baseDir) {
  let current = baseDir;
  while (true) {
    // Only list folders; files are not relevant for selecting a watch directory
    const { folders } = listFoldersAndFiles(current);
    const isRoot = current === baseDir;

    let choices = [];
    if (!isRoot) {
      choices.push({ name: "↩️ .. (go up)", value: "__UP__" }); // Add back icon for 'go up'
    }

    if (folders.length > 0) {
      choices = choices.concat(
        folders.map(f => ({ name: f, value: f.replace(/^📁\s*/, '') }))
      );
    }

    choices.push(new inquirer.Separator());

    // Allow selecting "this folder" if it's NOT the root directory
    if (!isRoot) {
      choices.push({ name: "✅ Select this folder", value: "__SELECT_THIS_FOLDER__" });
    } else {
      // This message is for the specific rule of not watching the project root itself
      console.log(
        "⚠️ You must select a subfolder, not the project root directory directly for watching.",
      );
    }

    // Add a specific message if no subfolders are available at the root and user can't select root
    if (isRoot && folders.length === 0) {
      console.log(
        "⚠️ No subfolders found here. Please create one in your project root or choose a different root.",
      );
      // In this specific case, if no choices are available (only __UP__ and __CANCEL__),
      // Inquirer will still throw ValidationError if 'Select this folder' is also not allowed.
      // The current promptFolderTraversal already leads to this error if choices are empty
      // so it's generally good to ensure 'choices' is never truly empty by offering a 'back' or 'cancel'.
      // If it reaches here and `choices` is only '..', then the error will still occur if it's the root.
      // We need to ensure there's always a valid selection or exit option.
    }

    // If no folders and at root, and 'Select this folder' is not allowed,
    // ensure there's an exit option to prevent ValidationError.
    if (isRoot && folders.length === 0 && choices.length <= 1) { // Only '..' might be present
      choices.push({ name: "❌ Go back to Main Menu", value: "__BACK_TO_MAIN__" });
    }


    const { folder } = await inquirer.prompt([
      {
        type: "list",
        name: "folder",
        message: `Current path for watcher: ${path.relative(baseDir, current) || "."}`,
        choices,
      },
    ]);

    if (folder === "__SELECT_THIS_FOLDER__") {
      return current; // Return the current path if selected
    } else if (folder === "__UP__") {
      current = path.dirname(current);
    } else if (folder === "__BACK_TO_MAIN__") {
      return null; // User chose to go back
    }
    else {
      current = path.join(current, folder); // The value already has emoji stripped
    }
  }
}

// ... (rest of your existing code remains the same) ...
// NEW HELPER: Function to get SCSS files directly in a directory (no subdirectories)
function listScssFilesAtRoot(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".scss"))
      .map((d) => d.name);
  } catch (error) {
    // console.error(`❌ Error reading directory ${dir}: ${error.message}`); // Suppress this specific error here, handled higher up
    return [];
  }
}

// UPDATED: promptStylesFile to enforce root-level SCSS files and reuse existing
async function promptStylesFile() {
  // Ensure _globalRootDir is valid before proceeding
  if (!_globalRootDir || !fs.existsSync(_globalRootDir) || !fs.lstatSync(_globalRootDir).isDirectory()) {
    console.log("❌ Project root is not set or is invalid. Please set a valid project root first.");
    return null; // Indicate failure
  }

  const availableRootScssFiles = listScssFilesAtRoot(_globalRootDir);

  const previouslyUsedRootFiles = new Set();
  // Filter existing watcher styles files to only include those truly at the root
  for (const [name, { config }] of watchers) {
    // Check if stylesFile has no path separators, meaning it's a direct child of root
    // Also, ensure the file actually exists and is readable.
    const fullPath = path.resolve(_globalRootDir, config.stylesFile);
    if (!config.stylesFile.includes(path.sep) && fs.existsSync(fullPath) && fs.lstatSync(fullPath).isFile()) {
      previouslyUsedRootFiles.add(config.stylesFile);
    }
  }

  // Combine available files and previously used files, ensuring uniqueness and sorting
  const choicesSet = new Set([
    ...availableRootScssFiles,
    ...Array.from(previouslyUsedRootFiles),
  ]);
  const sortedChoices = Array.from(choicesSet)
    .sort()
    .map((f) => ({ name: `📄 ${f}`, value: f }));

  if (sortedChoices.length === 0) {
    console.log("⚠️ No existing SCSS files found at the project root to select.");
  }


  const { selectedFile } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedFile",
      message:
        "Select an SCSS file for imports or enter a new one (must be at project root):",
      choices: [
        ...sortedChoices,
        new inquirer.Separator(),
        { name: "🆕 Enter a new file name", value: "__new" },
        { name: "↩️ Go back", value: "__back" },
      ],
    },
  ]);

  if (selectedFile === "__back") {
    return null; // Indicates user wants to go back
  }

  if (selectedFile !== "__new") return selectedFile; // Return selected existing file

  // If "__new" is selected, prompt for a new filename and validate
  while (true) {
    const { newFileName } = await inquirer.prompt([
      {
        type: "input",
        name: "newFileName",
        message:
          "Enter the name for the new SCSS file (e.g., main.scss - must be at project root, no subfolders):",
        validate: (input) => {
          if (!input.trim()) return "File name cannot be empty.";
          if (!input.toLowerCase().endsWith(".scss"))
            return "File name must end with .scss";
          // Check for path separators
          if (input.includes("/") || input.includes("\\"))
            return "File cannot be in a subfolder; it must be at the project root.";
          return true;
        },
      },
    ]);
    return newFileName.trim(); // Return the validated filename
  }
}

async function promptWatcherName(defaultName, excludeName = null) {
  while (true) {
    const { name } = await inquirer.prompt([
      {
        type: "input",
        name: "name",
        message: "Name this watcher:",
        default: defaultName,
      },
    ]);
    if (name === excludeName || !watchers.has(name)) return name;
    console.log(
      "❌ Watcher name already exists. Please choose a different name.",
    );
  }
}

// Helper to extract the import path from an @import line, harmonized with scssImportWatcher's.
function getImportPathFromLine(line) {
  const match = line.match(/@import\s*['"](.+?)['"];/);
  return match ? match[1].replace(/\\/g, "/") : null; // Normalize to POSIX style
}

/**
 * Performs a global cleanup on all SCSS styles files managed by current watchers,
 * plus any explicitly provided files.
 * It removes all existing marker blocks and any floating imports that will be managed by a *currently active* watcher.
 * @param {string[]} [additionalFilesToClean=[]] - List of absolute file paths to also clean.
 */
async function cleanAndRewriteAllStylesFiles(additionalFilesToClean = []) {
  const allStylesFiles = new Set();
  const watcherConfigs = Array.from(watchers.values()).map((w) => w.config);

  // Collect all unique styles files used by *any active* watcher
  watcherConfigs.forEach((config) => {
    allStylesFiles.add(path.resolve(_globalRootDir, config.stylesFile));
  });

  // Add any explicitly requested files to clean (e.g., from stopped watchers)
  additionalFilesToClean.forEach((filePath) => {
    allStylesFiles.add(filePath);
  });

  if (allStylesFiles.size === 0) {
    // No styles files to process, either active or explicit.
    return;
  }

  console.log("🧹 Performing global cleanup and re-homing of SCSS imports...");

  for (const stylesFilePath of allStylesFiles) {
    if (!fs.existsSync(stylesFilePath)) {
      console.warn(
        `⚠️ Styles file not found during cleanup: ${path.basename(stylesFilePath)}. Skipping.`,
      );
      continue;
    }

    let fileContent = fs.readFileSync(stylesFilePath, "utf8");
    let lines = fileContent.split(/\r?\n/);
    let cleanedLines = [];

    // Set to store all import paths that *any* currently configured watcher will manage,
    // specifically for *this* stylesFilePath.
    const allManagedImportPathsForThisFile = new Set();

    // Populate allManagedImportPathsForThisFile
    for (const config of watcherConfigs) {
      // Only consider watchers that write to *this specific* stylesFilePath
      if (path.resolve(_globalRootDir, config.stylesFile) === stylesFilePath) {
        // Create a temporary instance to get its generated import paths
        const tempWatcher = scssImportWatcher({
          ...config,
          label: `TEMP_CLEANUP_FOR_${config.name}`,
          markerId: config.name,
        });
        const generatedPaths = tempWatcher._getGeneratedImportPaths();
        tempWatcher.close();

        generatedPaths.forEach((p) => {
          allManagedImportPathsForThisFile.add(p);
        });
      }
    }

    let inAnyMarkerBlock = false; // Flag to track if we are inside ANY marker block

    // Process lines to remove old marker blocks and floating managed imports
    for (const line of lines) {
      // Update inAnyMarkerBlock flag based on marker start/end lines
      const startMatch = line.match(/\/\*\s*(.+?) import start\s*\*\//);
      const endMatch = line.match(/\/\*\s*(.+?) import end\s*\*\//);

      if (startMatch) {
        inAnyMarkerBlock = true;
        // Skip the start marker line itself as it will be re-inserted by its owning watcher
        continue;
      } else if (endMatch) {
        inAnyMarkerBlock = false;
        // Skip the end marker line itself
        continue;
      }

      // If we are inside any marker block, skip the content for now.
      // This content will be re-generated by the appropriate active watcher.
      if (inAnyMarkerBlock) {
        continue;
      }

      // Handle floating imports outside any marker block
      const importPath = getImportPathFromLine(line); // This now extracts and normalizes
      if (importPath) {
        // If this floating import path is managed by *any* currently active watcher
        // (i.e., it's in allManagedImportPathsForThisFile), then remove it.
        // This is where the 'duplicate removal' happens for floating imports.
        if (allManagedImportPathsForThisFile.has(importPath)) {
          continue; // Skip this import line as it will be re-homed
        }
      }

      // Keep lines that are not markers, not inside markers, and not managed imports
      cleanedLines.push(line);
    }

    // Remove any excessive blank lines left after cleanup
    const finalContent = cleanedLines.join("\n").replace(/\n{3,}/g, "\n\n");

    fs.writeFileSync(stylesFilePath, finalContent, "utf8");
    console.log(`✅ Cleaned imports in ${path.basename(stylesFilePath)}.`);
  }
}

async function updateWatcherExclusions(additionalFilesToClean = []) {
  const currentWatcherConfigs = Array.from(watchers.values()).map(
    (w) => w.config,
  );

  // Close all existing watcher instances
  for (const [name, { instance }] of watchers) {
    if (instance) {
      instance.close();
    }
  }
  watchers.clear(); // Clear the map before re-populating

  // NEW: Perform global cleanup, including explicitly provided files.
  // This step removes old marker blocks and floating imports claimed by *active* watchers.
  await cleanAndRewriteAllStylesFiles(additionalFilesFilesToClean); // Typo fixed here: additionalFilesToClean

  // Re-create all watchers with updated exclusion paths
  for (const config of currentWatcherConfigs) {
    const currentWatcherWatchFolderAbs = path.resolve(
      config.rootDir,
      config.watchDir,
    );
    const excludePathsForThisWatcher = [];

    for (const otherConfig of currentWatcherConfigs) {
      if (config.name === otherConfig.name) continue;

      const otherWatcherWatchFolderAbs = path.resolve(
        otherConfig.rootDir,
        otherConfig.watchDir,
      );

      if (
        otherWatcherWatchFolderAbs.startsWith(
          currentWatcherWatchFolderAbs + path.sep,
        )
      ) {
        excludePathsForThisWatcher.push(otherWatcherWatchFolderAbs);
      }
    }

    const instance = scssImportWatcher({
      ...config,
      label: `${config.name}: ${config.watchDir} → ${config.stylesFile}`,
      markerId: config.name,
      excludePaths: excludePathsForThisWatcher,
    });
    watchers.set(config.name, { config, instance });
    instance._initialUpdate(); // This will now write to a cleaned file
  }
  console.log("🔄 Watchers re-initialized with updated exclusion paths.");
}

async function createWatcherFlow() {
  const rootDir = _globalRootDir;

  console.log(`\nUsing project root: ${rootDir}`);
  // Use the existing promptFolderTraversal, which has the "subfolder" rule
  const watchFolderPath = await promptFolderTraversal(rootDir);
  if (watchFolderPath === null) { // User chose to go back
    return;
  }

  // Check if a watcher already exists for this exact folder
  let existingWatcherName = null;
  for (const [name, { config }] of watchers) {
    const existingWatchFolderAbs = path.resolve(
      config.rootDir,
      config.watchDir,
    );
    if (existingWatchFolderAbs === watchFolderPath) {
      existingWatcherName = name;
      break;
    }
  }

  if (existingWatcherName) {
    // Watcher exists, ask to edit or create new
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: `A watcher named "${existingWatcherName}" already exists for this folder (${path.relative(rootDir, watchFolderPath)}). What do you want to do?`,
        choices: [
          {
            name: `✏️ Edit watcher "${existingWatcherName}"`,
            value: "edit_existing",
          },
          {
            name: "➕ Create a NEW watcher (for a subfolder or different styles file)",
            value: "create_new",
          },
          { name: "↩️ Go back to Main Menu", value: "back" },
        ],
      },
    ]);

    if (action === "edit_existing") {
      await editWatcherFlow(existingWatcherName);
      return; // Exit create flow
    } else if (action === "back") {
      return; // Exit create flow, go back to main menu
    }
    // If "create_new" is chosen, flow continues below for new watcher creation
  }

  // --- Original new watcher creation logic continues here if no existing watcher or "create new" was chosen ---
  const stylesFile = await promptStylesFile();
  if (stylesFile === null) {
    // User chose to go back from styles file selection
    return;
  }
  const name = await promptWatcherName(path.basename(watchFolderPath));

  const config = {
    rootDir: rootDir,
    watchDir: path.relative(rootDir, watchFolderPath),
    stylesFile: stylesFile, // This will now be a root-level filename
    name,
  };

  watchers.set(name, { config, instance: null });
  // Calling updateWatcherExclusions will trigger global cleanup and then re-initialize all watchers,
  // including the newly created one, which will correctly manage its imports.
  updateWatcherExclusions();

  console.log("\n✅ Watcher successfully created:");
  console.log(`   📁 Watch folder: ${config.watchDir}`);
  console.log(`   📄 Styles file: ${config.stylesFile}`);
  console.log(`   🏷️  Name: ${name}\n`);
}

async function editWatcherFlow(nameToEdit) {
  const { config: oldConfig, instance: oldInstance } = watchers.get(nameToEdit);

  console.log(`\n✏️ Editing watcher: "${nameToEdit}"`);
  console.log(
    `   Current watch folder: ${path.relative(oldConfig.rootDir, path.resolve(oldConfig.rootDir, oldConfig.watchDir))}`,
  );
  console.log(`   Current styles file: ${oldConfig.stylesFile}`);

  let newWatchFolderPathAbs = path.resolve(
    oldConfig.rootDir,
    oldConfig.watchDir,
  );
  const { changeWatchFolder } = await inquirer.prompt([
    {
      type: "confirm",
      name: "changeWatchFolder",
      message: "Do you want to change the watch folder?",
      default: false,
    },
  ]);
  if (changeWatchFolder) {
    // Use promptFolderTraversal here as well
    newWatchFolderPathAbs = await promptFolderTraversal(oldConfig.rootDir);
    if (newWatchFolderPathAbs === null) { // User chose to go back
      return;
    }
  }

  let newStylesFile = oldConfig.stylesFile;
  const { changeStylesFile } = await inquirer.prompt([
    {
      type: "confirm",
      name: "changeStylesFile",
      message: "Do you want to change the styles file?",
      default: false,
    },
  ]);
  if (changeStylesFile) {
    newStylesFile = await promptStylesFile();
    if (newStylesFile === null) {
      // User chose to go back
      return; // Return to the previous menu (show watchers or main menu)
    }
  }

  let newName = nameToEdit;
  const { changeName } = await inquirer.prompt([
    {
      type: "confirm",
      name: "changeName",
      message: "Do you want to change the watcher name?",
      default: false,
    },
  ]);
  if (changeName) {
    newName = await promptWatcherName(nameToEdit, nameToEdit); // Pass current name as excludeName
  }

  const filesToCleanExplicitly = new Set();
  // IMPORTANT: If stylesFile changes, remove markers and delete imports from the OLD file.
  // This is a complete re-pointing of the watcher, so old file should be cleaned.
  if (newStylesFile !== oldConfig.stylesFile) {
    console.log(
      `🗑️ Cleaning up old markers AND IMPORTS for "${oldConfig.name}" from ${path.basename(oldConfig.stylesFile)}...`,
    );
    // Create a temporary watcher instance configured *with the old settings*
    // to correctly target and clean up the old file.
    const tempOldWatcher = scssImportWatcher({
      rootDir: oldConfig.rootDir,
      watchDir: oldConfig.watchDir, // The old watchDir is needed to form the old marker text
      stylesFile: oldConfig.stylesFile, // The old styles file is where markers need to be removed
      label: `CLEANUP: ${oldConfig.name}`,
      markerId: oldConfig.name, // Use the old watcher name as marker ID for cleanup
    });
    tempOldWatcher.removeMarkers(true); // Pass true to delete imports entirely from the old file
    tempOldWatcher.close(); // Close the temporary instance
    // No need to add oldConfig.stylesFile to filesToCleanExplicitly, it's already cleaned.
  }

  // Always close the old instance as it will be re-created with updated config
  if (oldInstance) {
    oldInstance.close();
  }

  // If the name changed, remove the old entry from the map
  if (newName !== nameToEdit) {
    watchers.delete(nameToEdit);
  }

  // Create new config object with updated values
  const newConfig = {
    ...oldConfig, // Keep rootDir the same
    watchDir: path.relative(oldConfig.rootDir, newWatchFolderPathAbs),
    stylesFile: newStylesFile, // This will now be a root-level filename
    name: newName,
  };

  // Update the map with the new config (instance will be created by updateWatcherExclusions)
  watchers.set(newName, { config: newConfig, instance: null });

  // Re-initialize all watchers to apply changes and update exclusions
  // Pass any explicit files to clean (e.g., if stylesFile changed, its old file is handled above)
  updateWatcherExclusions(Array.from(filesToCleanExplicitly));

  console.log("\n✅ Watcher successfully updated:");
  console.log(`   📁 Watch folder: ${newConfig.watchDir}`);
  console.log(`   📄 Styles file: ${newConfig.stylesFile}`);
  console.log(`   🏷️  Name: ${newConfig.name}\n`);
}

/**
 * Handles deletion of watchers, either single, multiple, or all.
 * @param {string|string[]|null} [watcherNames=null] - A single watcher name (string), an array of names, or '__all'. If null, prompts user.
 */
async function deleteWatcherFlow(watcherNames = null) {
  let watchersToDelete = [];

  if (watcherNames === "__all") {
    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message:
          "Are you sure you want to DELETE ALL watchers? This cannot be undone.",
      },
    ]);
    if (!confirm) return;
    watchersToDelete = Array.from(watchers.keys());
  } else if (typeof watcherNames === "string") {
    watchersToDelete.push(watcherNames); // Single watcher deletion
  } else if (Array.isArray(watcherNames)) {
    watchersToDelete = watcherNames; // Multiple watchers deletion (e.g., from checkbox)
  } else {
    // Prompt user to select if watcherNames is null
    if (watchers.size === 0) {
      console.log("⚠️ No watchers to delete.");
      return;
    }
    const choices = Array.from(watchers.keys()).map((name) => ({
      name: `${name}: ${watchers.get(name).config.watchDir} → ${watchers.get(name).config.stylesFile}`,
      value: name,
    }));
    choices.push(new inquirer.Separator());
    choices.push({ name: "🗑️ Delete ALL watchers", value: "__all" });
    choices.push({ name: "❌ Cancel", value: "__cancel" });

    const { selected } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "selected",
        message: "Select watcher(s) to delete:",
        choices,
      },
    ]);

    if (selected.includes("__cancel") || selected.length === 0) return;

    if (selected.includes("__all")) {
      const { confirm } = await inquirer.prompt([
        {
          type: "confirm",
          name: "confirm",
          message: "Are you sure you want to DELETE ALL watchers?",
        },
      ]);
      if (!confirm) return;
      watchersToDelete = Array.from(watchers.keys());
    } else {
      watchersToDelete = selected;
    }
  }

  const filesToCleanExplicitly = new Set();

  for (const name of watchersToDelete) {
    if (!watchers.has(name)) continue; // In case a watcher was already deleted by "__all" or an invalid name was passed

    const { config, instance } = watchers.get(name);
    if (instance) {
      // Add the styles file of the deleted watcher to the explicit cleanup list.
      // This ensures its file gets processed by global cleanup, especially if imports were left.
      filesToCleanExplicitly.add(
        path.resolve(_globalRootDir, config.stylesFile),
      );

      // Remove markers from the deleted watcher's file, but KEEP the import statements.
      // These imports will become 'floating' and will be managed by global cleanup if claimed by a new watcher.
      instance.removeMarkers(false);
      instance.close();
    }
    watchers.delete(name);
    console.log(`🗑️ Deleted watcher: ${name}`);
  }

  await updateWatcherExclusions(Array.from(filesToCleanExplicitly));

  if (watchers.size === 0) {
    console.log("All watchers have been deleted.");
  }
}

async function showWatchersFlow() {
  if (watchers.size === 0) {
    console.log("⚠️ No watchers configured yet.");
    return;
  }

  const watcherChoices = Array.from(watchers.entries()).map(
    ([name, { config }]) => ({
      name: `${name}: ${config.watchDir} → ${config.stylesFile}`,
      value: name,
    }),
  );

  const { selectedWatcher } = await inquirer.prompt([
    {
      type: "list",
      name: "selectedWatcher",
      message: "Select a watcher to manage:",
      choices: [
        ...watcherChoices,
        new inquirer.Separator(),
        { name: "↩️ Go back to Main Menu", value: "__back" },
        { name: "🗑️ Delete ALL watchers", value: "__deleteAll" },
      ],
    },
  ]);

  if (selectedWatcher === "__back") {
    return;
  } else if (selectedWatcher === "__deleteAll") {
    await deleteWatcherFlow("__all");
  } else {
    // A specific watcher was selected
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: `Manage watcher "${selectedWatcher}":`,
        choices: [
          { name: "✏️ Edit this watcher", value: "edit" },
          { name: "🗑️ Delete this watcher", value: "delete" },
          { name: "↩️ Go back", value: "back" },
        ],
      },
    ]);

    if (action === "edit") {
      await editWatcherFlow(selectedWatcher);
    } else if (action === "delete") {
      await deleteWatcherFlow(selectedWatcher);
    }
    // If "back", just return, the main menu will be shown again.
  }
}

async function mainMenu() {
  // Prompt for root folder only once at the very beginning
  if (!_globalRootDir) {
    _globalRootDir = await promptRootFolder();
    console.log(`\nProject root set to: ${_globalRootDir}\n`);
  }

  while (true) {
    const { action } = await inquirer.prompt([
      {
        type: "list",
        name: "action",
        message: "Main menu:",
        choices: [
          { name: "➕ Create new watcher", value: "create" },
          { name: "👀 Show watchers", value: "show" }, // New option
          { name: "🗑️ Delete watcher(s)", value: "delete" }, // Renamed from "Stop"
          { name: "🚪 Exit", value: "exit" },
        ],
      },
    ]);

    if (action === "create") {
      await createWatcherFlow();
    } else if (action === "show") {
      // New action handler
      await showWatchersFlow();
    } else if (action === "delete") {
      // Updated action handler
      await deleteWatcherFlow(null); // Call deleteFlow without specific names to prompt user
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
        // When exiting, delete all watchers and explicitly clean their files with full import removal.
        const allFilesToCleanOnExit = new Set();
        for (const [name, { config, instance }] of watchers) {
          if (instance) {
            // For a clean exit, delete all markers and imports from files currently managed.
            instance.removeMarkers(true);
            instance.close();
          }
          allFilesToCleanOnExit.add(
            path.resolve(_globalRootDir, config.stylesFile),
          );
        }
        watchers.clear();
        // A final global cleanup for any lingering issues.
        await cleanAndRewriteAllStylesFiles(Array.from(allFilesToCleanOnExit));

        console.log("👋 Bye!");
        process.exit(0);
      }
    }
  }
}

mainMenu();