const chokidar = require("chokidar");
const fs = require("fs");
const path = require("path");

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

/**
 * @param {Object} options
 * @param {string} options.rootDir - Root directory
 * @param {string} options.watchDir - Folder to watch (relative to rootDir)
 * @param {string} options.stylesFile - Styles file to update (relative to rootDir)
 * @param {string} options.label - Label for logging
 * @param {string} [options.markerId] - Unique identifier for markers (e.g., watcher name). Defaults to basename of watchDir.
 * @param {string[]} [options.excludePaths=[]] - Absolute paths to exclude from imports (nested watcher folders)
 */
function scssImportWatcher({
  rootDir = process.cwd(),
  watchDir = "src/scss/components",
  stylesFile = "src/scss/styles.scss",
  label = undefined,
  markerId = undefined, // Accepts a specific ID for markers
  excludePaths = [],
} = {}) {
  const watchFolder = path.resolve(rootDir, watchDir);
  const stylesFilePath = path.resolve(rootDir, stylesFile);

  // Use provided markerId, or fallback to the basename of the watch folder
  const effectiveMarkerId = markerId || path.basename(watchFolder);

  function log(message) {
    const prefix = label ? `🛠 [${label}]` : "🛠";
    console.log(`${prefix} ${message}`);
  }

  /**
   * Recursively get all SCSS files inside dir,
   * excluding any files inside folders matching excludePaths.
   * @param {string} dir - absolute directory path
   * @param {string} relativeDir - relative path from watchFolder
   * @returns {string[]} relative paths to SCSS files inside watchFolder
   */
  function getAllScssFiles(dir, relativeDir = "") {
    if (!fs.existsSync(dir)) return [];

    for (const excludePath of excludePaths) {
      if (dir === excludePath || dir.startsWith(excludePath + path.sep)) {
        return [];
      }
    }

    let results = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry /** @type {fs.Dirent} */ of entries) {
      // Explicitly type entry
      const fullPath = path.join(dir, entry.name);
      const relPath = path.join(relativeDir, entry.name);

      let isExcluded = false;
      for (const excludePath of excludePaths) {
        if (
          fullPath === excludePath ||
          fullPath.startsWith(excludePath + path.sep)
        ) {
          isExcluded = true;
          break;
        }
      }
      if (isExcluded) continue;

      if (entry.isDirectory()) {
        results = results.concat(getAllScssFiles(fullPath, relPath));
      } else if (entry.isFile() && entry.name.endsWith(".scss")) {
        results.push(relPath);
      }
    }
    return results;
  }

  function groupByFolder(files) {
    const groups = {};

    for (const file of files) {
      const parts = file.split(path.sep);
      const folder = parts.length > 1 ? parts[0] : "root";

      if (!groups[folder]) groups[folder] = [];
      groups[folder].push(file);
    }

    return groups;
  }

  function generateImports() {
    const files = getAllScssFiles(watchFolder);
    const grouped = groupByFolder(files);
    const imports = [];
    const sortedFolders = Object.keys(grouped).sort();

    let isFirstFolderGroup = true;

    for (const folder of sortedFolders) {
      const filesInFolder = grouped[folder];

      if (folder !== "root" && !isFirstFolderGroup) {
        imports.push("");
      }
      isFirstFolderGroup = false;

      if (folder !== "root") imports.push(`/* ${folder} */`);

      for (let file of filesInFolder) {
        const parts = file.split(path.sep);
        let filename = parts
          .pop()
          .replace(/^_/, "")
          .replace(/\.scss$/, "");
        parts.push(filename);

        // Ensure POSIX path for @import statements regardless of OS
        const relativeImportPath = path.posix.join(
          watchDir.replace(/\\/g, "/"), // Ensure watchDir is also POSIX-style for joining
          ...parts,
        );

        imports.push(`@import "${relativeImportPath}";`);
      }
    }
    if (imports.length > 0 && imports[imports.length - 1] !== "") {
      imports.push("");
    }

    return imports.join("\n");
  }

  function updateStylesFile(silent = false) {
    if (!silent) {
      log("⌛ Detected change. Updating import statements...");
    }

    try {
      let content = fs.readFileSync(stylesFilePath, "utf8");

      const newImports = generateImports(); // This is the string we want to insert

      // Find the existing block for this watcher's ID
      // Using new RegExp to reset lastIndex and ensure fresh search
      const markerBlockRegex = new RegExp(
        `\\/\\*\\s*${effectiveMarkerId} import start\\s\\*\\/([\\s\\S]*?)\\/\\*\\s*${effectiveMarkerId} import end\\s*\\/`,
        "g",
      );
      let currentMatch = markerBlockRegex.exec(content);

      if (currentMatch) {
        // If a block with *our* effectiveMarkerId already exists, replace it
        const before = content.slice(0, currentMatch.index);
        const after = content.slice(markerBlockRegex.lastIndex);
        content = `${before}/* ${effectiveMarkerId} import start */\n${newImports}\n/* ${effectiveMarkerId} import end */${after}`;
      } else {
        // If a block with our effectiveMarkerId does not exist, append it.
        // Assume file is already cleaned by global cleanup before this point.
        let prefix = content.trimEnd();
        if (prefix.length > 0 && !prefix.endsWith("\n\n")) {
          prefix += "\n\n";
        } else if (prefix.length > 0 && !prefix.endsWith("\n")) {
          prefix += "\n";
        } else if (prefix.length === 0) {
          prefix = "";
        }
        content = `${prefix}/* ${effectiveMarkerId} import start */\n${newImports}\n/* ${effectiveMarkerId} import end */\n`;
      }

      fs.writeFileSync(stylesFilePath, content, "utf8");
      if (!silent) {
        log(
          `✅ Successfully updated imports between markers for "${effectiveMarkerId}" in ${path.basename(stylesFilePath)}`,
        );
      }
    } catch (err) {
      log(
        `❌ Error updating styles file (${path.basename(stylesFilePath)}): ${err.message}`,
      );
    }
  }

  /**
   * Removes the marker block from the styles file.
   * @param {boolean} [deleteImports=false] - If true, the import statements between markers are also deleted.
   * If false, only markers are removed, imports remain floating.
   */
  function removeMarkers(deleteImports = false) {
    try {
      let content = fs.readFileSync(stylesFilePath, "utf8");
      const lines = content.split(/\r?\n/);

      let startLineIndex = -1;
      let endLineIndex = -1;

      // Find markers specific to this watcher's effectiveMarkerId
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes(`/* ${effectiveMarkerId} import start */`))
          startLineIndex = i;
        if (lines[i].includes(`/* ${effectiveMarkerId} import end */`))
          endLineIndex = i;
        if (startLineIndex !== -1 && endLineIndex !== -1) break;
      }

      if (
        startLineIndex === -1 ||
        endLineIndex === -1 ||
        endLineIndex <= startLineIndex
      ) {
        log(
          `⚠️ Markers for "${effectiveMarkerId}" not found properly in ${path.basename(stylesFilePath)}, nothing to remove.`,
        );
        return;
      }

      const contentBeforeMarkers = lines.slice(0, startLineIndex);
      const importsContent = lines.slice(startLineIndex + 1, endLineIndex); // Content between markers
      const contentAfterMarkers = lines.slice(endLineIndex + 1);

      let newContentLines = [];
      newContentLines = newContentLines.concat(contentBeforeMarkers);

      if (!deleteImports) {
        // If keeping imports, add them back along with necessary spacing
        if (
          contentBeforeMarkers.length > 0 &&
          contentBeforeMarkers[contentBeforeMarkers.length - 1].trim() !== "" &&
          importsContent.length > 0
        ) {
          newContentLines.push("");
        }
        newContentLines = newContentLines.concat(importsContent);
      }

      // Add blank line before contentAfterMarkers if necessary for separation
      // This logic ensures clean separation whether imports were kept or deleted
      if (
        newContentLines.length > 0 && // Check if there's content before
        newContentLines[newContentLines.length - 1].trim() !== "" && // Check if last line is not blank
        contentAfterMarkers.length > 0 && // Check if there's content after
        contentAfterMarkers[0].trim() !== "" // Check if first line of contentAfterMarkers is not blank
      ) {
        newContentLines.push("");
      }

      newContentLines = newContentLines.concat(contentAfterMarkers);

      // Clean up excessive blank lines (more than two consecutive)
      const finalContent = newContentLines
        .join("\n")
        .replace(/\n{3,}/g, "\n\n");

      fs.writeFileSync(stylesFilePath, finalContent, "utf8");
      log(
        `✅ Removed markers ${deleteImports ? "and imports " : ""}for "${effectiveMarkerId}" from ${path.basename(stylesFilePath)}`,
      );
    } catch (err) {
      log(
        `❌ Error removing markers from ${path.basename(stylesFilePath)}: ${err.message}`,
      );
    }
  }

  // Debounced update for reactive file changes (add, unlink, change)
  const debouncedReactiveUpdate = debounce(() => updateStylesFile(false), 100);

  const watcher = chokidar.watch(watchFolder, {
    persistent: true,
    ignoreInitial: true, // IMPORTANT: Set to true to prevent initial 'add' events from firing
    depth: Infinity,
  });

  // Event listeners
  watcher.on("add", debouncedReactiveUpdate);
  watcher.on("unlink", debouncedReactiveUpdate);
  watcher.on("change", debouncedReactiveUpdate);

  return {
    close: () => watcher.close(),
    removeMarkers: removeMarkers, // Exposed the new flexible removeMarkers function
    _initialUpdate: () => updateStylesFile(true), // Method to call for initial, silent update
    // New function to get the paths this watcher would generate
    _getGeneratedImportPaths: () => {
      return generateImports()
        .split("\n")
        .map((line) => getImportPathFromLine(line)) // Use the same normalization here
        .filter(Boolean); // Filter out nulls and empty strings
    },
  };
}

module.exports = scssImportWatcher;
