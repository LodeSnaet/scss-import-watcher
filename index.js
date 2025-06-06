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
 * @param {string} options.label - Label for logging
 * @param {number} options.line - The 1-indexed line number in stylesFile where the marker block should be placed.
 * @param {string} [options.markerId] - Unique identifier for markers (e.g., watcher name). Defaults to basename of watchDir
 * @param {string[]} [options.excludePaths] - Array of absolute paths to exclude from watching.
 */
function scssImportWatcher(options) {
  const { rootDir, watchDir, stylesFile, label, line, markerId, excludePaths = [] } = options;

  // Define effectiveMarkerId in the main scope of scssImportWatcher
  const effectiveMarkerId = markerId || path.basename(watchDir);

  const watchFolder = path.resolve(rootDir, watchDir);
  const stylesFilePath = path.resolve(rootDir, stylesFile);

  const markerStart = `/* SCSS_IMPORTS_START_${effectiveMarkerId} */`;
  const markerEnd = `/* SCSS_IMPORTS_END_${effectiveMarkerId} */`;

  let _currentGeneratedImportPathsCache = new Set();
  let _currentGroupedImportsCache = {}; // Stores imports grouped by watch subfolder
  let _isActive = true; // New: Watcher active state

  const log = (message, type = "info") => {
    if (!_isActive && type !== "error") {
      // Don't log info/warn messages if paused, but always log errors
      return;
    }
    const prefix = {
      info: "ℹ️",
      warn: "⚠️",
      error: "❌",
    }[type];
    console.log(`${prefix} [${label || effectiveMarkerId || "scss-watcher"}] ${message}`);
  };


  function generateImports() {
    _currentGeneratedImportPathsCache.clear();
    _currentGroupedImportsCache = {};

    if (!_isActive) {
      log("Skipping import generation: Watcher is paused.", "info");
      return;
    }

    try {
      const files = fs.readdirSync(watchFolder, { recursive: true, withFileTypes: true });

      for (const file of files) {
        if (file.isFile() && file.name.endsWith(".scss")) {
          const filePathAbsolute = path.join(file.path, file.name);

          // Check for exclusion paths
          const isExcluded = excludePaths.some(excludedPath =>
              filePathAbsolute.startsWith(excludedPath)
          );
          if (isExcluded) {
            log(`Ignoring excluded file: ${path.relative(rootDir, filePathAbsolute)}`, "info");
            continue;
          }

          if (filePathAbsolute === stylesFilePath) {
            // log(`Ignoring main styles file: ${path.relative(rootDir, stylesFilePath)}`, "info");
            continue; // Skip the main styles file itself
          }

          // Check if it's a partial (starts with '_')
          if (file.name.startsWith("_")) {
            const importPath = path.relative(watchFolder, filePathAbsolute);
            // Normalize to POSIX style and remove leading underscore and extension
            const normalizedImportPath = importPath
                .replace(/\\/g, "/") // Convert to POSIX
                .replace(/^_/, "") // Remove leading underscore
                .replace(/\.scss$/, ""); // Remove .scss extension

            _currentGeneratedImportPathsCache.add(normalizedImportPath);

            const relativeToWatchDir = path.relative(watchFolder, filePathAbsolute);
            const parentDirKey = path.dirname(relativeToWatchDir);
            if (!_currentGroupedImportsCache[parentDirKey]) {
              _currentGroupedImportsCache[parentDirKey] = [];
            }
            _currentGroupedImportsCache[parentDirKey].push(normalizedImportPath);
          }
        }
      }
      log(`Generated imports for ${Object.values(_currentGroupedImportsCache).flat().length} files.`);
    } catch (err) {
      log(`❌ Error generating imports from ${watchFolder}: ${err.message}`, "error");
    }
  }

  function updateStylesFile(initial = false) {
    if (!_isActive && !initial) { // Allow initial update even if paused
      log("Skipping styles file update: Watcher is paused.", "info");
      return;
    }

    if (!fs.existsSync(stylesFilePath)) {
      log(`❌ Styles file not found: ${stylesFilePath}`, "error");
      return;
    }

    try {
      let content = fs.readFileSync(stylesFilePath, "utf8");
      let lines = content.split(/\r?\n/);

      const newImports = Array.from(_currentGeneratedImportPathsCache)
          .sort()
          .map((p) => `@import "${p}";`);

      let newContentLines = [];
      let inMarkerBlock = false;
      let inserted = false;

      for (let i = 0; i < lines.length; i++) {
        const lineContent = lines[i];

        if (lineContent.includes(markerStart)) {
          inMarkerBlock = true;
          // When we hit the start marker, we replace the existing block
          // with our generated imports (or empty if none).
          newContentLines.push(markerStart);
          if (newImports.length > 0) {
            newContentLines.push(""); // Add a blank line for spacing before imports
            newContentLines.push(...newImports);
            newContentLines.push(""); // Add a blank line for spacing after imports
          }
          newContentLines.push(markerEnd);
          inserted = true;
          continue; // Skip existing imports in the block
        }

        if (lineContent.includes(markerEnd)) {
          inMarkerBlock = false;
          continue; // Skip the old end marker as it's already added with new block
        }

        if (!inMarkerBlock) {
          newContentLines.push(lineContent);
        }
      }

      if (!inserted) {
        // If markers weren't found, insert at the specified line number
        const insertAt = Math.min(Math.max(0, line - 1), newContentLines.length);

        const importsBlockLines = [
          markerStart,
          // Add blank line before imports if there are imports
          ...(newImports.length > 0 ? ["", ...newImports] : []),
          // Add blank line after imports if there are imports
          ...(newImports.length > 0 ? [""] : []), // This blank line ensures separation from subsequent content
          markerEnd,
        ];

        // Use spread operator to insert individual lines from the block
        newContentLines.splice(insertAt, 0, ...importsBlockLines);

        log(`No existing markers found. Inserted imports at line ${line}.`);
      } else {
        log(`Updated imports in ${path.basename(stylesFilePath)}.`);
      }

      // Normalize multiple blank lines to at most two
      const finalContent = newContentLines.join("\n").replace(/\n{3,}/g, "\n\n");

      fs.writeFileSync(stylesFilePath, finalContent, "utf8");
    } catch (err) {
      log(`❌ Error updating ${path.basename(stylesFilePath)}: ${err.message}`, "error");
    }
  }


  function removeMarkers(deleteImports = false) {
    // effectiveMarkerId is now from the outer scope
    // stylesFilePath is also from the outer scope
    // markerStart and markerEnd are also from the outer scope

    try {
      const content = fs.readFileSync(stylesFilePath, "utf8");
      const lines = content.split(/\r?\n/);
      let newContentLines = []; // Changed from 'const' to 'let'
      let inMarkerBlock = false;
      let contentAfterMarkers = [];

      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.includes(markerStart)) {
          inMarkerBlock = true;
          if (!deleteImports) {
            // If not deleting imports, keep the start marker
            newContentLines.push(line);
          }
          continue;
        }
        if (line.includes(markerEnd)) {
          inMarkerBlock = false;
          if (!deleteImports) {
            // If not deleting imports, keep the end marker
            newContentLines.push(line);
          }
          // Capture content after the marker block to append later
          contentAfterMarkers = lines.slice(i + 1);
          break; // Stop processing lines within the loop
        }
        if (!inMarkerBlock) {
          newContentLines.push(line);
        }
      }

      newContentLines = newContentLines.concat(contentAfterMarkers);

      const finalContent = newContentLines
          .join("\n")
          .replace(/\n{3,}/g, "\n\n");

      fs.writeFileSync(stylesFilePath, finalContent, "utf8");
      log(
          `✅ Removed markers ${deleteImports ? "and imports " : ""}for "${effectiveMarkerId}" from ${path.basename(stylesFilePath)}`
      );
    } catch (err) {
      log(
          `❌ Error removing markers from ${path.basename(stylesFilePath)}: ${err.message}`
      );
    }
  }

  const debouncedReactiveUpdate = debounce(() => updateStylesFile(false), 100);

  const watcher = chokidar.watch(watchFolder, {
    persistent: true,
    ignoreInitial: true, // We call _initialUpdate manually
    depth: Infinity,
    ignored: excludePaths, // Use excludePaths here
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