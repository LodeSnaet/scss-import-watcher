const chokidar = require("chokidar");
const fs = require("fs");
const path = require("path");

function scssImportWatcher({
                               rootDir = process.cwd(),
                               watchDir = "src/scss/components",
                               stylesFile = "src/scss/styles.scss",
                               startMarker = "/* COMPONENTS IMPORT START */",
                               endMarker = "/* COMPONENTS IMPORT END */",
                           } = {}) {
    const componentsDir = path.resolve(rootDir, watchDir);
    const stylesFilePath = path.resolve(rootDir, stylesFile);

    // Recursively get all scss files with relative paths
    function getAllScssFiles(dir, relativeDir = "") {
        let results = [];
        const entries = fs.readdirSync(dir, { withFileTypes: true });

        for (const entry of entries) {
            const fullPath = path.join(dir, entry.name);
            const relPath = path.join(relativeDir, entry.name);

            if (entry.isDirectory()) {
                results = results.concat(getAllScssFiles(fullPath, relPath));
            } else if (entry.isFile() && entry.name.endsWith(".scss")) {
                results.push(relPath);
            }
        }
        return results;
    }

    // Group files by first folder (or root)
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

    // Generate @import statements grouped by folder
    function generateImports() {
        const files = getAllScssFiles(componentsDir);
        const groups = groupByFolder(files);
        let importLines = [];

        for (const [folder, files] of Object.entries(groups)) {
            if (folder !== "root") importLines.push(`// ${folder}`);

            files.forEach((file) => {
                const cleanName = file.replace(/^_/, "").replace(/\.scss$/, "");
                const importPath = `${watchDir}/${cleanName}`.replace(/\\/g, "/");
                importLines.push(`@import "${importPath}";`);
            });

            importLines.push(""); // blank line between groups
        }

        return importLines.join("\n");
    }

    // Update the styles file with import statements between markers
    function updateStylesFile() {
        if (!fs.existsSync(stylesFilePath)) {
            console.error(`Styles file not found: ${stylesFilePath}`);
            return;
        }

        const content = fs.readFileSync(stylesFilePath, "utf8");
        const startIndex = content.indexOf(startMarker);
        const endIndex = content.indexOf(endMarker);

        if (startIndex === -1 || endIndex === -1 || endIndex < startIndex) {
            console.error("Markers not found or in wrong order in styles file.");
            return;
        }

        const before = content.slice(0, startIndex + startMarker.length);
        const after = content.slice(endIndex);

        const imports = generateImports();

        const newContent = `${before}\n${imports}\n${after}`;

        fs.writeFileSync(stylesFilePath, newContent, "utf8");
        console.log("Updated styles imports");
    }

    // Start watcher
    const watcher = chokidar.watch(componentsDir, {
        persistent: true,
        ignoreInitial: false,
        depth: Infinity,
    });

    watcher.on("add", (filePath) => {
        console.log(`File added: ${filePath}`);
        updateStylesFile();
    });

    watcher.on("unlink", (filePath) => {
        console.log(`File removed: ${filePath}`);
        updateStylesFile();
    });

    // Initial update on start
    updateStylesFile();

    // Return an interface to close watcher if needed
    return {
        close: () => watcher.close(),
    };
}

module.exports = scssImportWatcher;
