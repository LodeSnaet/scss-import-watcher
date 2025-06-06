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
  // Fixed regex for more robust matching of @import statements
  const match = line.match(/@import\s*['"](.+?)['"];/);
  // Normalize extracted path to POSIX style (forward slashes) for consistent comparison
  return match ? match[1].replace(/\\/g, "/") : null;
}

// Helper function to escape special characters in a string for use in a RegExp
function escapeRegExp(string) {
  return string.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); // $& means the matched substring
}

/**
 * @param {Object} options
 * @param {string} options.rootDir - Root directory (absolute path for the entire project)
 * @param {string} options.watchDir - Folder to watch (relative to rootDir, defines grouping logic base)
 * @param {string} options.stylesFile - Styles file to update (relative to rootDir)
 * @param {string} options.label - Label for logging
 * @param {number} options.line - The 1-indexed line number in stylesFile where the marker block should be placed.
 * @param {string} [options.markerId] - Unique identifier for markers (e.g., watcher name). Defaults to basename of watchDir.
 * @param {string[]} [options.excludePaths=[]] - Array of paths (relative to rootDir) to exclude from watching.
 */
function scssImportWatcher(options) {
  const rootDir = path.resolve(options.rootDir); // Ensure rootDir is always absolute
  const watchDir = path.resolve(rootDir, options.watchDir);
  const stylesFilePath = path.resolve(rootDir, options.stylesFile);
  const label = options.label || path.basename(options.watchDir);
  const insertLine = options.line - 1; // Convert to 0-indexed
  const effectiveMarkerId = options.markerId || path.basename(options.watchDir);

  // Define marker strings based on the new format
  const markerStart = `/* ${effectiveMarkerId} import start */`;
  const markerEnd = `/* ${effectiveMarkerId} import end */`;

  // Define group marker prefix
  const GROUP_MARKER_PREFIX = `/*`;
  const GROUP_MARKER_SUFFIX = `*/`;

  let _currentGroupedImportsCache = {}; // Stores imports grouped by their top-level directory (e.g., 'components': ['@import "components/button";'])
  let _isActive = true; // New state for pause/resume

  // Basic logging function
  const log = (message, type = "info") => {
    const prefix = {
      info: "ℹ️",
      warn: "⚠️",
      error: "❌",
      debug: "🐛"
    }[type];
    // Only log if the watcher is active, unless it's a critical error or shutdown message
    if (_isActive || type === "error" || message.startsWith("👋") || message.startsWith("⚙️") || type === "debug") {
      console.log(`${prefix} [SCSS Watcher - ${label}] ${message}`);
    }
  };

  function generateImports() {
    if (!_isActive) {
      log("Skipping import generation: Watcher is paused.", "info");
      return;
    }

    _currentGroupedImportsCache = {}; // Reset for each run
    log(`Starting import generation for watchDir: ${watchDir}`, "debug");

    // Recursive function to read directories
    function readDirRecursive(currentDir) {
      if (!fs.existsSync(currentDir)) {
        log(`Warning: Directory not found - ${currentDir}`, "warn");
        return;
      }

      const files = fs.readdirSync(currentDir);
      files.forEach((file) => {
        const fullPath = path.join(currentDir, file);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
          // Check if directory should be excluded (absolute path comparison)
          const isExcluded = (options.excludePaths || []).some(excludedPath =>
              fullPath === path.resolve(rootDir, excludedPath) || fullPath.startsWith(path.resolve(rootDir, excludedPath) + path.sep)
          );
          if (isExcluded) {
            log(`Ignoring excluded directory: ${path.relative(rootDir, fullPath)}`, "debug");
          } else {
            readDirRecursive(fullPath); // Recurse into subdirectories
          }
        } else if (stat.isFile() && file.startsWith("_") && file.endsWith(".scss")) {
          // It's a SCSS partial, add to imports
          if (fullPath === stylesFilePath) {
            log(`Ignoring main styles file itself: ${path.relative(rootDir, fullPath)}`, "debug");
            return; // Skip the main styles file itself
          }

          // --- Calculate the full import path from the project root (rootDir) ---
          let fullImportPathRaw = path.relative(rootDir, fullPath); // e.g., "test/test2/_hello.scss"
          fullImportPathRaw = fullImportPathRaw.replace(/\\/g, "/"); // Normalize to POSIX

          const importPathDir = path.dirname(fullImportPathRaw); // e.g., "test/test2" or "test/test2/hello"
          let importPathBase = path.basename(fullImportPathRaw, '.scss'); // e.g., "_hello" or "_hellotest"

          // Remove leading underscore from the filename part for the import statement
          if (importPathBase.startsWith('_')) {
            importPathBase = importPathBase.substring(1); // e.g., "hello" or "hellotest"
          }

          const importPath = path.posix.join(importPathDir, importPathBase); // The final string for @import

          // --- Determine the group key based on its path *relative to the watchDir* ---
          // This logic is distinct from the importPath to achieve the desired grouping.
          let relativePathToWatchDir = path.relative(watchDir, fullPath);
          relativePathToWatchDir = relativePathToWatchDir.replace(/\\/g, "/"); // Normalize to POSIX

          const groupKeyDir = path.dirname(relativePathToWatchDir); // e.g., "." for files directly in watchDir, or "hello"
          const groupKeyParts = relativePathToWatchDir.split('/'); // e.g., ["_hello.scss"] or ["hello", "_hellotest.scss"]

          // Logic for groupKey: 'base' if directly in watchDir or an immediate child, otherwise the first segment relative to watchDir
          const groupKey = (groupKeyDir === '.' || groupKeyParts.length === 1) ? 'base' : groupKeyParts[0];

          log(`Processing file: ${path.relative(rootDir, fullPath)}`, "debug");
          log(`  -> Calculated Import Path: "${importPath}"`, "debug");
          log(`  -> Calculated Group Key: "${groupKey}"`, "debug");


          if (!_currentGroupedImportsCache[groupKey]) {
            _currentGroupedImportsCache[groupKey] = [];
          }
          _currentGroupedImportsCache[groupKey].push(`@import "${importPath}";`);
        }
      });
    }

    readDirRecursive(watchDir);

    // Sort imports within each group alphabetically
    for (const groupKey in _currentGroupedImportsCache) {
      _currentGroupedImportsCache[groupKey].sort();
    }
    // Sort group keys to ensure consistent order (e.g., 'base' first, then alphabetical)
    const sortedGroupKeys = Object.keys(_currentGroupedImportsCache).sort((a, b) => {
      if (a === 'base') return -1;
      if (b === 'base') return 1;
      return a.localeCompare(b);
    });

    const sortedCache = {};
    sortedGroupKeys.forEach(key => {
      sortedCache[key] = _currentGroupedImportsCache[key];
    });
    _currentGroupedImportsCache = sortedCache; // Update cache with sorted groups
    log(`Finished import generation. Found ${Object.values(_currentGroupedImportsCache).flat().length} imports.`, "debug");
  }

  function updateStylesFile(initialUpdate = false) {
    if (!fs.existsSync(stylesFilePath)) {
      log(`Styles file not found: ${stylesFilePath}. Please create it.`, "error");
      return;
    }

    try {
      let content = fs.readFileSync(stylesFilePath, "utf8");
      // Use '\n' for actual newline character
      const lines = content.split('\n');

      let startIndex = -1;
      let endIndex = -1;

      // Find marker positions
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(markerStart)) {
          startIndex = i;
        }
        if (lines[i].includes(markerEnd)) {
          endIndex = i;
        }
      }

      let newImportsContent = "";
      if (Object.keys(_currentGroupedImportsCache).length > 0) {
        for (const groupKey in _currentGroupedImportsCache) {
          if (_currentGroupedImportsCache[groupKey].length > 0) {
            // Add group marker
            newImportsContent += `${GROUP_MARKER_PREFIX} ${groupKey} ${GROUP_MARKER_SUFFIX}\n`;
            // Add imports for this group
            newImportsContent += _currentGroupedImportsCache[groupKey].join('\n') + '\n';
          }
        }
        newImportsContent = newImportsContent.trimEnd(); // Remove trailing newline if any
      }


      let newContentLines = [];

      // If markers exist, replace content between them
      if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
        // Content before start marker
        newContentLines = lines.slice(0, startIndex + 1);
        // Insert new imports block
        newContentLines.push(newImportsContent);
        // Content after end marker
        newContentLines = newContentLines.concat(lines.slice(endIndex));
      } else {
        // If markers don't exist, insert them at the specified line or end of file
        const insertionLine = Math.min(insertLine, lines.length);

        // Content before insertion line
        newContentLines = lines.slice(0, insertionLine);
        // Insert markers and imports
        newContentLines.push(markerStart);
        newContentLines.push(newImportsContent);
        newContentLines.push(markerEnd);
        // Content after insertion line
        newContentLines = newContentLines.concat(lines.slice(insertionLine));
      }

      // Use '\n' for actual newline character in join and regex
      const finalContent = newContentLines
          .join('\n')
          .replace(/\n{3,}/g, '\n\n'); // Normalize multiple newlines to max two

      fs.writeFileSync(stylesFilePath, finalContent, "utf8");
      if (initialUpdate) {
        log(`Initial update for "${effectiveMarkerId}" completed.`, "info");
      } else if (_isActive) {
        log(`Styles file ${path.basename(stylesFilePath)} updated for "${effectiveMarkerId}".`, "info");
      }
    } catch (err) {
      log(`❌ Error updating styles file: ${err.message}`, "error");
    }
  }

  function removeMarkers(deleteImports = false) {
    if (!fs.existsSync(stylesFilePath)) {
      log(`Styles file not found: ${stylesFilePath}`, "warn");
      return;
    }

    try {
      let content = fs.readFileSync(stylesFilePath, "utf8");
      // Use '\n' for actual newline character
      const lines = content.split('\n');

      let startIndex = -1;
      let endIndex = -1;

      // Find marker positions using the new format
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(markerStart)) {
          startIndex = i;
        }
        if (lines[i].includes(markerEnd)) {
          endIndex = i;
        }
      }

      if (startIndex !== -1 && endIndex !== -1 && startIndex < endIndex) {
        let newContentLines = lines.slice(0, startIndex);
        if (!deleteImports) {
          // If not deleting imports, find the content *between* the group markers
          // and re-insert it, effectively just removing the start/end/group markers
          let contentBetweenMarkers = [];
          for (let i = startIndex + 1; i < endIndex; i++) {
            const line = lines[i];
            // Only keep lines that are NOT group markers
            if (!line.includes(GROUP_MARKER_PREFIX) || !line.includes(GROUP_MARKER_SUFFIX)) {
              contentBetweenMarkers.push(line);
            }
          }
          newContentLines = newContentLines.concat(contentBetweenMarkers);
        }
        // Use '\n' for actual newline character
        newContentLines = newContentLines.concat(lines.slice(endIndex + 1));

        // Use '\n' for actual newline character
        const finalContent = newContentLines
            .join('\n')
            .replace(/\n{3,}/g, '\n\n');

        fs.writeFileSync(stylesFilePath, finalContent, "utf8");
        log(
            `✅ Removed markers ${deleteImports ? "and imports " : ""}for "${effectiveMarkerId}" from ${path.basename(stylesFilePath)}`, "info"
        );
      } else {
        // log(`Markers for "${effectiveMarkerId}" not found in ${path.basename(stylesFilePath)}. Nothing to remove.`);
      }
    } catch (err) {
      log(
          `❌ Error removing markers from ${path.basename(stylesFilePath)}: ${err.message}`, "error"
      );
    }
  }

  const debouncedReactiveUpdate = debounce(() => updateStylesFile(false), 100);

  const watcher = chokidar.watch(watchDir, {
    persistent: true,
    ignoreInitial: true, // We call _initialUpdate manually
    depth: Infinity,
    ignored: (options.excludePaths || []).map(p => path.resolve(rootDir, p)) // Pass absolute paths to chokidar's ignored option
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
        log(`Watcher for "${effectiveMarkerId}" paused.`, "info");
      } else {
        log(`Watcher for "${effectiveMarkerId}" is already paused.`, "info");
      }
    },
    resume: () => {
      if (!_isActive) {
        _isActive = true;
        log(`Watcher for "${effectiveMarkerId}" resumed.`, "info");
        // Trigger an immediate update in case changes occurred while paused
        debouncedReactiveUpdate();
      } else {
        log(`Watcher for "${effectiveMarkerId}" is already running.`, "info");
      }
    },
    getIsActive: () => _isActive // New: Method to check current active state
  };
}

module.exports = scssImportWatcher;