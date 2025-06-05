#!/usr/bin/env node

const path = require("path");
const scssImportWatcher = require("../index");

const args = process.argv.slice(2);

if (args.includes("-h") || args.includes("--help")) {
    console.log(`
Usage: scss-import-watcher [options]

Options:
  [watchDir]     Folder to watch inside the root (default: src/scss/components)
  [stylesFile]   Styles file path relative to root (default: src/scss/styles.scss)
  [rootDir]      Root directory (default: current working directory)

Example:
  scss-import-watcher src/scss/components src/scss/styles.scss /my/project/root
  `);
    process.exit(0);
}

const [watchDir = "src/scss/components", stylesFile = "src/scss/styles.scss", rootDir = process.cwd()] = args;

scssImportWatcher({ rootDir, watchDir, stylesFile });
