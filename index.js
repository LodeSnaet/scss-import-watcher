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
 * @param {Object} options
 * @param {string} options.rootDir - Root directory
 * @param {string} options.watchDir - Folder to watch (relative to rootDir)
 * @param {string} options.stylesFile - Styles file to update (relative to rootDir)
 * @param {string} options.label - Label for logging
 * @param {string[]} [options.excludePaths=[]] - Absolute paths to exclude from imports (nested watcher folders)
 */
function scssImportWatcher({
                               rootDir = process.cwd(),
                               watchDir = "src/scss/components",
                               stylesFile = "src/scss/styles.scss",
                               label = undefined,
                               excludePaths = [],
                           } = {}) {
    const watchFolder = path.resolve(rootDir, watchDir);
    const stylesFilePath = path.resolve(rootDir, stylesFile);

    // Get the last folder name from watchDir for marker labels
    const watchFolderName = path.basename(watchFolder);

    const startMarker = `/* ${watchFolderName} import start */`;
    const endMarker = `/* ${watchFolderName} import end */`;

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

        // If this dir is inside any excludePaths, skip completely
        for (const excludePath of excludePaths) {
            if (dir === excludePath || dir.startsWith(excludePath + path.sep)) {
                return [];
            }
        }

        let results = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relPath = path.join(relativeDir, entry.name);

            // Skip if fullPath is inside excluded paths
            let isExcluded = false;
            for (const excludePath of excludePaths) {
                if (fullPath === excludePath || fullPath.startsWith(excludePath + path.sep)) {
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
        const sortedFolders = Object.keys(grouped).sort(); // Sort folders for consistent order

        let isFirstFolder = true;

        for (const folder of sortedFolders) {
            const filesInFolder = grouped[folder];

            // Add an extra blank line before folder comments if it's not the first folder group
            if (folder !== "root" && !isFirstFolder) {
                imports.push(""); // Add blank line before the folder comment
            }
            isFirstFolder = false;

            // --- MODIFIED LINE HERE: Ensures ALL folder comments use block format ---
            if (folder !== "root") imports.push(`/* ${folder} */`); // Changed to block comment. If 'root' should also have a comment, this 'if' condition needs to be adjusted.
            // --- END MODIFIED LINE ---

            for (let file of filesInFolder) {
                const parts = file.split(path.sep);
                let filename = parts.pop().replace(/^_/, "").replace(/\.scss$/, "");
                parts.push(filename);

                // Build import path relative to watchDir with forward slashes
                const relativeImportPath = path.posix.join(
                    watchDir.replace(/\\/g, "/"),
                    ...parts
                );

                imports.push(`@import "${relativeImportPath}";`);
            }
        }
        // Ensure there's a blank line at the very end of the generated block,
        // which will then be followed by the end marker.
        if (imports.length > 0 && imports[imports.length - 1] !== "") {
            imports.push("");
        }

        return imports.join("\n");
    }

    function updateStylesFile() {
        log("⌛ Detected change. Updating import statements...");

        try {
            let content = fs.readFileSync(stylesFilePath, "utf8");

            // Regex to match all blocks between any markers like /* folderName import start */ ... /* folderName import end */
            // Using non-greedy .*? and capturing the folderName in group 1
            const markerBlockRegex = /\/\*\s*(.+?) import start\s*\*\/([\s\S]*?)\/\*\s*\1 import end\s*\*\//g;

            // Build a map of existing marker blocks by folder name
            let existingBlocks = {};
            let match;
            while ((match = markerBlockRegex.exec(content)) !== null) {
                const folderName = match[1];
                const blockContent = match[2];
                const start = match.index;
                const end = markerBlockRegex.lastIndex;
                existingBlocks[folderName] = { start, end, blockContent };
            }

            // Generate the import block for the current watcher
            const newImports = generateImports();

            if (existingBlocks[watchFolderName]) {
                // Replace only this watcher's block
                const { start, end } = existingBlocks[watchFolderName];

                // Content before this block
                const before = content.slice(0, start);

                // Content after this block
                const after = content.slice(end);

                // Rebuild content with updated imports in this block
                content = `${before}/* ${watchFolderName} import start */\n${newImports}\n/* ${watchFolderName} import end */${after}`;
            } else {
                // Markers for current watcher do not exist, append them at end with spacing
                // Ensure two blank lines before adding a new block if content exists
                let prefix = content.trimEnd();
                if (prefix.length > 0 && !prefix.endsWith('\n\n')) { // Check if not already ending with two blank lines
                    prefix += '\n\n';
                } else if (prefix.length > 0 && !prefix.endsWith('\n')) { // Check if ending with one blank line
                    prefix += '\n';
                } else if (prefix.length === 0) { // If file is empty, no blank lines needed before first block
                    prefix = '';
                }

                content = `${prefix}/* ${watchFolderName} import start */\n${newImports}\n/* ${watchFolderName} import end */\n`;
            }

            fs.writeFileSync(stylesFilePath, content, "utf8");
            log(`✅ Successfully updated imports between markers for "${watchFolderName}"`);
        } catch (err) {
            log(`❌ Error updating styles file: ${err.message}`);
        }
    }

    // New method to remove markers but keep imports with spaces around
    function removeMarkersButKeepImports() {
        try {
            let content = fs.readFileSync(stylesFilePath, "utf8");
            const lines = content.split(/\r?\n/);

            let startLineIndex = -1;
            let endLineIndex = -1;

            for (let i = 0; i < lines.length; i++) {
                if (lines[i].includes(startMarker)) startLineIndex = i;
                if (lines[i].includes(endMarker)) endLineIndex = i;
                if (startLineIndex !== -1 && endLineIndex !== -1) break;
            }

            if (startLineIndex === -1 || endLineIndex === -1 || endLineIndex <= startLineIndex) {
                log("⚠️ Markers not found properly in lines, nothing to remove.");
                return;
            }

            // Get the content before the markers (including potentially a blank line before the start marker)
            const contentBeforeMarkers = lines.slice(0, startLineIndex);

            // Get the actual import lines (between the markers)
            const importsContent = lines.slice(startLineIndex + 1, endLineIndex);

            // Get the content after the markers
            const contentAfterMarkers = lines.slice(endLineIndex + 1);

            // Reconstruct the content
            let newContentLines = [];

            // Add lines before the block
            newContentLines = newContentLines.concat(contentBeforeMarkers);

            // Add a blank line if the last line before the block isn't already blank,
            // AND there's actual non-empty content before the block.
            if (contentBeforeMarkers.length > 0 && contentBeforeMarkers[contentBeforeMarkers.length - 1].trim() !== '') {
                newContentLines.push('');
            }
            // No need for an else if here, as importsContent will be added next regardless.

            // Add the actual import statements
            newContentLines = newContentLines.concat(importsContent);

            // Add a blank line after the imports block if there's content following it.
            // This prevents the problem of imports immediately touching the next block.
            if (contentAfterMarkers.length > 0 && importsContent.length > 0) {
                newContentLines.push('');
            }

            // Add lines after the block
            newContentLines = newContentLines.concat(contentAfterMarkers);

            fs.writeFileSync(stylesFilePath, newContentLines.join("\n"), "utf8");
            log(`✅ Removed markers and ensured spacing for import block for "${watchFolderName}"`);
        } catch (err) {
            log(`❌ Error removing markers: ${err.message}`);
        }
    }


    const debouncedUpdate = debounce(updateStylesFile, 100);

    const watcher = chokidar.watch(watchFolder, {
        persistent: true,
        ignoreInitial: false,
        depth: Infinity,
    });

    watcher.on("add", debouncedUpdate);
    watcher.on("unlink", debouncedUpdate);
    watcher.on("change", debouncedUpdate);

    updateStylesFile();

    return {
        close: () => watcher.close(),
        removeMarkersButKeepImports,
    };
}

module.exports = scssImportWatcher;