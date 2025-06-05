# ⚡️ SCSS Import Watcher CLI

A powerful and intuitive command-line interface tool designed to automate the management of your SCSS `@import` statements. Say goodbye to manually adding or removing imports as your project structure evolves!

---

## ✨ Features

This CLI simplifies your SCSS workflow by automatically generating and maintaining `@import` statements in your main SCSS file(s) based on the contents of your watched directories.

* **Interactive Setup**: A user-friendly command-line interface guides you through the setup process.
* **Project Root Definition**: Define a central root directory for your SCSS project.
* **Flexible Watcher Creation**:
  * Create **watchers** for any subfolder within your project root.
  * Specify a **single SCSS file at the root level** (e.g., `main.scss`, `styles.scss`) where all generated `@import` statements will be placed.
  * **Intelligent Import Management**: Automatically generates and updates `@import` statements for all `.scss` files found within your watched directories.
  * **Duplicate Prevention**: Smartly detects and removes redundant `@import` statements, ensuring your main SCSS file remains clean and efficient. If you stop a watcher and its imports become "floating," they'll be automatically "re-homed" or removed if a new watcher claims them.
* **Nested Watcher Exclusions**: Automatically configures exclusions so that nested watchers don't duplicate imports from their parent watchers.
* **Watcher Management Dashboard**:
  * **View All Watchers**: Get a clear list of all your active watchers, showing their watched folder and target SCSS file.
  * **Edit Watchers**: Modify an existing watcher's watched folder, target SCSS file, or even its name. The system handles cleanup and relocation of imports accordingly.
  * **Delete Watchers**: Remove individual watchers or delete all of them. When deleting a watcher, its markers are removed, and imports are left as "floating" (to be cleaned up if a new watcher claims them).
* **Clean Exit**: Ensures all watchers are gracefully shut down and their managed imports are removed (fully or partially, based on configuration) when you exit the CLI.
* **Visual Cues**: Uses simple text-based icons (📁, 📄, ↩️) in interactive prompts to enhance readability and navigation.

---

## 🚫 Limitations

While powerful, this tool has a few limitations to be aware of:

* **No SCSS Compilation**: This tool **does not compile your SCSS** into CSS. You'll need a separate SCSS compiler (like Node-Sass, Dart Sass, or a build tool like Webpack/Gulp) for that.
* **Directory Watching Only**: Watchers monitor entire directories for `.scss` files; they do not target individual files for specific content.
* **Root-Level Styles File**: The target SCSS file where imports are written (`stylesFile`) **must reside directly in your project's root directory**. It cannot be in a subfolder.
* **Text-Based UI**: The CLI uses basic console prompts. It does not provide a graphical user interface (GUI) or rich visual elements beyond standard Unicode characters.
* **SCSS `@import` Specific**: It specifically manages `@import` statements for SCSS files and does not handle other types of CSS `@import` or `@use` rules outside of its scope.

---

## ⚠️ Important Considerations

* **Floating Imports After Deletion**: When a watcher is deleted, its specific marker comments are removed, but the generated `@import` statements themselves are retained (they become "floating" imports).
  * If these floating imports are then managed by a **newly created or existing watcher** for the *same content* (e.g., you create a new watcher for the exact same folder), the CLI will not automatically re-home them within the new watcher's markers, be mindful for duplicates.

---

## 🚀 Getting Started & Usage

To use this CLI, you'll need Node.js installed on your system.

### Installation Options

There are two primary ways to install and run the `scss-import-watcher` CLI:

#### 1. Project-Specific Installation (Recommended for Project Use)

This method installs the CLI as a development dependency within your project, allowing it to be managed via `npm scripts`. This is ideal for project-specific automation and ensures consistent versions across your team.

1.  **Install the package in your project:**
    Navigate to your project's root directory and install it as a dev dependency:
    ```bash
      npm i scss-import-watcher
    ```
    *(Note: If you're actively developing the `scss-import-watcher` package locally and testing it within your project without publishing, use `npm link scss-import-watcher-cli` instead of `npm install` after running `npm link` in your package's root.)*

2.  **Add a script to your project's `package.json`:**
    Open your project's `package.json` file and add an entry to the `"scripts"` section to easily run the CLI. We recommend using `npx` to ensure the locally installed version is executed.

    ```json
    "scripts": {
      "watch-scss": "npx scss-watcher"
    }
    ```
    Remember to use the command name (`scss-watcher`) that you defined in the `bin` field of the `scss-import-watcher-cli` package's `package.json`.

3.  **Run the CLI from your project root:**
    ```bash
    npm run watch-scss
    ```
