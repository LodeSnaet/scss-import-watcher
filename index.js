// scss-import-watcher/index.js

const fs = require("fs");
const path = require("path");
const chokidar = require("chokidar");

function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      fn(...args);
      timer = null;
    }, delay);
  };
}

/**
 * Helper to extract the import path from an @import line and normalize it to POSIX style.
 * @param {string} line
 * @returns {string|null} The normalized import path (e.g., "components/button") or null if not an @import line.
 */
function getImportPathFromLine(line) {
  const match = line.match(/@import\s*['"](.+?)['"];/);
  // Normalize extracted path to POSIX style (forward slashes) for consistent comparison
  return match ? match[1].replace(/\\/g, "/") : null;
}

// Helper function to escape special characters in a string for use in a RegExp
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // $& means the matched substring
}

/**
 * @param {Object} options
 * @param {string} options.rootDir - Root directory
 * @param {string} options.watchDir - Folder to watch (relative to rootDir)
 * @param {string} options.stylesFile - Styles file to update (relative to rootDir)
 * @param {string} options.name - Name of the watcher (used as label)
 * @param {number} options.line - Line number in stylesFile to insert imports
 * @param {string} [options.markerId] - Optional unique marker ID for this watcher (defaults to watchDir name)
 * @param {string[]} [options.excludePaths=[]] - Paths to exclude from watching (relative to rootDir)
 * @param {Object} [options.allWatchersConfigs={}] - All currently configured watcher configurations for cross-watcher filtering
 */
function scssImportWatcher(options) {
  const {
    rootDir,
    watchDir, // relative to rootDir
    stylesFile, // relative to rootDir
    name, // The user-defined name of this watcher
    line,
    markerId: userMarkerId, // User-provided markerId
    excludePaths = [],
    allWatchersConfigs = {} // All watcher configs passed from CLI
  } = options;

  // Use the user-provided markerId, or default to the watchDir name if not provided
  const effectiveMarkerId = userMarkerId || watchDir.replace(/[\/\\]/g, '_').replace(/^_/, ''); // Sanitize for marker if needed

  const absoluteStylesFilePath = path.resolve(rootDir, stylesFile);
  const absoluteWatchDir = path.resolve(rootDir, watchDir);

  let _currentGroupedImportsCache = {}; // Cache to hold generated imports by group
  let _isActive = true; // State for pause/resume

  // Debounce the reactive update function
  const debouncedReactiveUpdate = debounce(() => {
    if (_isActive) {
      log(`Triggering update for "${effectiveMarkerId}"...`);
      generateImports();
      updateStylesFile();
    } else {
      log(`Watcher "${effectiveMarkerId}" is paused. Skipping update.`);
    }
  }, 200);

  // Simple logging function
  const log = (message) => {
    // console.log(`[${name}] ${message}`); // Changed from label to name
  };

  function normalizeImportPath(relativePath) {
    let normalized = relativePath.replace(/\\/g, "/"); // Convert to POSIX style
    // Remove leading underscores for partials (e.g., _button.scss -> button)
    // Remove .scss extension
    normalized = normalized.replace(/^_/, "").replace(/\.scss$/, "");
    return normalized;
  }

  function generateImports() {
    log("Generating imports...");
    _currentGroupedImportsCache = {}; // Clear previous cache

    const discoveredFiles = []; // Store absolute paths of ALL .scss files

    function findScssFiles(currentDir) { // Renamed from findScssPartials
      if (!fs.existsSync(currentDir)) {
        log(`Directory not found: ${currentDir}`);
        return;
      }

      const entries = fs.readdirSync(currentDir, { withFileTypes: true });

      for (const entry of entries) {
        const absolutePath = path.join(currentDir, entry.name);
        const relativePathFromRoot = path.relative(rootDir, absolutePath).replace(/\\/g, "/");

        // Skip the main styles file itself to prevent self-importing
        if (absolutePath === absoluteStylesFilePath) {
          continue;
        }

        // Check against excludePaths for this specific watcher
        const isExcludedByThisWatcher = excludePaths.some(excluded => {
          const absoluteExcludedPath = path.resolve(rootDir, excluded);
          // Check if it's the exact file or a directory containing the file/folder
          return absolutePath === absoluteExcludedPath || absolutePath.startsWith(absoluteExcludedPath + path.sep);
        });

        if (isExcludedByThisWatcher) {
          log(`Excluding ${relativePathFromRoot} (explicitly excluded by this watcher).`);
          continue;
        }

        if (entry.isDirectory()) {
          findScssFiles(absolutePath); // Recursively find files
        } else if (entry.isFile() && entry.name.endsWith(".scss")) {
          discoveredFiles.push(absolutePath); // Add all .scss files
        }
      }
    }

    findScssFiles(absoluteWatchDir);

    const importsByGroup = {};

    log(`Watcher "${name}" (watchDir: "${watchDir}") is processing files...`);

    discoveredFiles.forEach((absoluteFilePath) => {
      const relativeFilePath = path.relative(rootDir, absoluteFilePath).replace(/\\/g, "/");
      const fileName = path.basename(absoluteFilePath);
      const dirName = path.dirname(relativeFilePath);

      log(`  - Considering file: ${relativeFilePath}`);

      let importStatementPath;
      let isPartial = fileName.startsWith("_");

      if (isPartial) {
        importStatementPath = normalizeImportPath(relativeFilePath);
      } else if (fileName === 'index.scss') {
        if (dirName === watchDir) { // If index.scss is in the current watcher's watchDir itself
          importStatementPath = watchDir;
        } else if (dirName.startsWith(watchDir + '/')) { // If index.scss is in a sub-directory of the current watcher's watchDir
          importStatementPath = dirName;
        } else {
          log(`    Warning: index.scss at unexpected path: ${relativeFilePath} for current watcher.`);
          return;
        }
      } else {
        importStatementPath = normalizeImportPath(relativeFilePath);
      }

      if (!importStatementPath) {
        log(`    Could not determine import path for ${relativeFilePath}. Skipping.`);
        return;
      }
      log(`    Determined import path: "${importStatementPath}" (Is Partial: ${isPartial})`);


      // --- isManagedByMoreSpecificWatcher logic ---
      let isManagedByMoreSpecificWatcher = false;
      // Only check if there are other watchers configured
      if (Object.keys(allWatchersConfigs).length > 1) {
        for (const otherWatcherName in allWatchersConfigs) {
          const otherWatcherConfig = allWatchersConfigs[otherWatcherName];

          // Skip self or invalid configs (no watchDir)
          if (otherWatcherConfig.name === name || !otherWatcherConfig.watchDir) {
            continue;
          }

          const otherWatcherRelativeWatchDir = otherWatcherConfig.watchDir.replace(/\\/g, "/");
          const currentWatcherRelativeWatchDir = watchDir.replace(/\\/g, "/");

          // Check 1: Is the other watcher's directory a direct sub-directory of *this* watcher's directory?
          // This makes sure we only consider child watchers, not sibling or parent watchers.
          const isOtherWatcherDescendant = otherWatcherRelativeWatchDir.startsWith(currentWatcherRelativeWatchDir + '/');

          // Check 2: Is the current file being processed located within that more specific watcher's directory?
          const isFileWithinOtherWatcherScope = relativeFilePath.startsWith(otherWatcherRelativeWatchDir + '/');


          // log(`    - Comparing with other watcher "${otherWatcherConfig.name}" (watchDir: "${otherWatcherRelativeWatchDir}")`);
          // log(`      - Is "${otherWatcherConfig.name}" a descendant of "${name}"? ${isOtherWatcherDescendant}`);
          // log(`      - Is file "${relativeFilePath}" within "${otherWatcherRelativeWatchDir}" scope? ${isFileWithinOtherWatcherScope}`);


          if (isOtherWatcherDescendant && isFileWithinOtherWatcherScope) {
            isManagedByMoreSpecificWatcher = true;
            log(`    Skipping ${relativeFilePath} for watcher "${name}" because it's handled by more specific watcher "${otherWatcherConfig.name}" (${otherWatcherRelativeWatchDir}).`);
            break; // No need to check other watchers, this file is managed elsewhere
          }
        }
      }


      if (isManagedByMoreSpecificWatcher) {
        return; // This file (partial or non-partial) is handled by a more specific watcher.
      }
      log(`    File ${relativeFilePath} will be included by watcher "${name}".`);

      // --- Grouping logic ---
      let groupKey;
      const watchDirSlash = watchDir + '/';
      let pathAfterWatchDir = '';

      // Determine the part of the import path that comes after the current watcher's watchDir.
      // This is used to logically group imports within the current watcher's block.
      if (importStatementPath.startsWith(watchDirSlash)) {
        pathAfterWatchDir = importStatementPath.substring(watchDirSlash.length);
      } else if (importStatementPath === watchDir) {
        // If the import path is the same as the watchDir (e.g., "@import "test2";" from "test2/index.scss" watched by "test2")
        pathAfterWatchDir = '';
      } else {
        // Fallback for cases where importStatementPath is not directly nested under watchDir,
        // or if watchDir is "." and importStatementPath is "somefolder/file".
        // In a well-configured system, this branch might indicate an issue or a root-level file.
        pathAfterWatchDir = importStatementPath;
      }

      if (pathAfterWatchDir.includes('/')) {
        // If there's a subdirectory in the path after watchDir, the group key is the first subdirectory name.
        // E.g., if watchDir is "test2", and pathAfterWatchDir is "hello/hellotest", groupKey is "hello".
        groupKey = pathAfterWatchDir.split('/')[0];
      } else {
        // If it's a direct file/folder import in the watchDir (e.g., "hello" from "test2/hello")
        // or a partial directly in watchDir (e.g., "_base.scss"), it belongs to the "base" group.
        groupKey = 'base';
      }
      log(`    Group Key: "${groupKey}"`);


      if (!importsByGroup[groupKey]) {
        importsByGroup[groupKey] = [];
      }
      importsByGroup[groupKey].push(`@import "${importStatementPath}";`);
    });

    // Sort imports within each group alphabetically
    for (const group in importsByGroup) {
      importsByGroup[group].sort();
    }

    _currentGroupedImportsCache = importsByGroup;
  }

  function updateStylesFile(force = false) {
    if (!fs.existsSync(absoluteStylesFilePath)) {
      log(`Target styles file not found: ${absoluteStylesFilePath}`);
      return;
    }

    let content = fs.readFileSync(absoluteStylesFilePath, "utf8");
    const lines = content.split('\n');

    // Create the full import block from the cache
    const newImports = [];
    for (const groupKey in _currentGroupedImportsCache) {
      newImports.push(`/* ${groupKey} */`);
      newImports.push(..._currentGroupedImportsCache[groupKey]);
    }
    const newImportsBlock = newImports.join('\n');

    const startMarker = `/* ${effectiveMarkerId} import start */`;
    const endMarker = `/* ${effectiveMarkerId} import end */`;

    let startIndex = -1;
    let endIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === startMarker) {
        startIndex = i;
      } else if (lines[i].trim() === endMarker) {
        endIndex = i;
        break; // Found the end marker after a start marker
      }
    }

    let newContentLines = [...lines]; // Create a copy to modify

    if (startIndex !== -1 && endIndex !== -1) {
      // Marker block exists, replace it
      newContentLines.splice(startIndex + 1, endIndex - startIndex - 1, newImportsBlock);
      log(`Updated existing import block for "${effectiveMarkerId}".`);
    } else {
      // Marker block does not exist, insert it
      const insertLineIndex = Math.min(Math.max(0, line - 1), lines.length); // Ensure valid line number

      newContentLines.splice(insertLineIndex, 0, startMarker, newImportsBlock, endMarker);
      log(`Inserted new import block for "${effectiveMarkerId}".`);
    }

    const finalContent = newContentLines.join('\n').replace(/\n{3,}/g, '\n\n'); // Normalize multiple newlines

    if (content !== finalContent || force) {
      fs.writeFileSync(absoluteStylesFilePath, finalContent, "utf8");
      log(`Styles file "${path.basename(absoluteStylesFilePath)}" updated.`);
    } else {
      // log("No changes detected in import block. Styles file not written."); // Removed for less clutter
    }
  }

  // Function to remove markers and their content
  function removeMarkers(andContent = false) {
    if (!fs.existsSync(absoluteStylesFilePath)) {
      log(`Target styles file not found for marker removal: ${absoluteStylesFilePath}`);
      return;
    }

    let content = fs.readFileSync(absoluteStylesFilePath, "utf8");
    const lines = content.split('\n');

    const startMarker = `/* ${effectiveMarkerId} import start */`;
    const endMarker = `/* ${effectiveMarkerId} import end */`;

    let startIndex = -1;
    let endIndex = -1;

    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === startMarker) {
        startIndex = i;
      } else if (lines[i].trim() === endMarker) {
        endIndex = i;
        break;
      }
    }

    if (startIndex !== -1 && endIndex !== -1) {
      if (andContent) {
        // Remove start marker, content, and end marker
        lines.splice(startIndex, endIndex - startIndex + 1);
        log(`Removed import block and markers for "${effectiveMarkerId}".`);
      } else {
        // Only remove markers, keep content (not typically desired, but an option)
        lines.splice(endIndex, 1); // Remove end marker
        lines.splice(startIndex, 1); // Remove start marker
        log(`Removed markers for "${effectiveMarkerId}", but kept content.`);
      }
      const finalContent = lines.join('\n').replace(/\n{3,}/g, '\n\n');
      fs.writeFileSync(absoluteStylesFilePath, finalContent, "utf8");
    } else {
      log(`No markers found for "${effectiveMarkerId}" to remove.`);
    }
  }


  // Initialize watcher with chokidar
  const watcher = chokidar.watch(absoluteWatchDir, {
    ignored: (filePath) => {
      // Ignore main styles file if it's inside the watchDir
      if (path.resolve(filePath) === absoluteStylesFilePath) {
        return true;
      }
      // If there are explicit exclude paths, handle them here
      const relativePathFromRoot = path.relative(rootDir, filePath).replace(/\\/g, "/");
      return excludePaths.some(excluded => {
        const absoluteExcludedPath = path.resolve(rootDir, excluded);
        return filePath === absoluteExcludedPath || filePath.startsWith(absoluteExcludedPath + path.sep);
      });
    },
    ignoreInitial: true, // Don't trigger 'add' events on startup
    persistent: true,
    depth: 99, // Watch subdirectories recursively
  });

  watcher.on("add", debouncedReactiveUpdate);
  watcher.on("unlink", debouncedReactiveUpdate);
  watcher.on("change", debouncedReactiveUpdate);
  watcher.on("addDir", debouncedReactiveUpdate);
  watcher.on("unlinkDir", debouncedReactiveUpdate);


  return {
    close: () => watcher.close(),
    removeMarkers: removeMarkers,
    _initialUpdate: () => {
      // Generate imports once to populate the cache before the first update.
      generateImports();
      updateStylesFile(true);
    },
    // This is primarily for the global cleanup function in CLI
    _getGeneratedImportPaths: () => {
      // Ensure generateImports is called to populate the cache
      generateImports();
      const allPaths = [];
      for (const groupKey in _currentGroupedImportsCache) {
        allPaths.push(..._currentGroupedImportsCache[groupKey]);
      }
      return allPaths;
    },
    // New: Pause and Resume functionality
    pause: () => {
      if (_isActive) {
        _isActive = false;
        log(`Watcher for "${effectiveMarkerId}" paused.`);
      } else {
        log(`Watcher for "${effectiveMarkerId}" is already paused.`);
      }
    },
    resume: () => {
      if (!_isActive) {
        _isActive = true;
        log(`Watcher for "${effectiveMarkerId}" resumed.`);
        // Trigger an immediate update in case changes occurred while paused
        debouncedReactiveUpdate();
      } else {
        log(`Watcher for "${effectiveMarkerId}" is already running.`);
      }
    },
    getIsActive: () => _isActive // New: Method to check current active state
  };
}

module.exports = scssImportWatcher;
