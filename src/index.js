const path = require("node:path");
const fs = require("node:fs");
const util = require("util");
const CSON = require("season");
const keyPathHelpers = require("key-path-helpers");

const UNKNOWN_PACKAGE_ID = "UNKNOWN-PACKAGE";
const AUTO_TRANSLATE_LABEL = /^%.+%$/;

module.exports =
class HealthCheck {
  constructor(cwd, userGlob) {
    this.cwd = cwd;
    this.userGlob = userGlob;

    // Modules
    this.glob = null;

    // Output
    this.results = {
      packages: {},
      commonsKeyMapsUsed: {}
    };

    // Options
    this.logResults = false;
  }

  async requireGlob() {
    if (this.glob === null) {
      this.glob = await import("glob").then(g => g.glob); // ESM export only
    }
  }

  // Scan with the provided glob to detect any and all locales
  async scan() {
    await this.requireGlob();

    const localeFiles = await this.glob(this.userGlob, { ignore: "node_modules/**", cwd: this.cwd, nodir: true });

    // Now when iterating through these locales, we must assume that we are
    // collecting data for different packages.
    for (const file of localeFiles) {
      const packageName = this.findPackageNameFromLocaleFile(file);

      if (packageName === UNKNOWN_PACKAGE_ID) {
        // This means we couldn't find the package.json and further work on this package
        // may prove problametic, technically we could still work on the
        // locale file, but for now, lets just abort this bad package
        console.error(`Unable to locate full package details for path: '${file}', Skipping...`);
        continue;
      }

      const packageJson = this.findPackageJsonFromLocaleFile(file);
      const localeFile = this.readLocaleFile(file);
      const hasDups = this.doesLocaleHaveDups(file);
      const menus = this.findPackageMenusFromLocaleFile(file);
      const locale = this.getLocaleFromPath(file);

      if (this.results.packages[packageName]) {
        // We already have an entry for this package, likely the glob picked up
        // multiple locale files for it, so we just want to add our new locale file
        // to it
        this.results.packages[packageName].localeFiles[locale] = localeFile;

      } else {
        this.results.packages[packageName] = {
          packageJson: packageJson,
          localeFiles: {},
          menus: menus,
          hasDups: hasDups,
          usedKeyPaths: {},
          hasEnLocale: false,
          totalKeyPaths: 0,
          dir: path.join(this.cwd, file, "../../"),
          errs: []
        };
        this.results.packages[packageName].localeFiles[locale] = localeFile;
      }

      if (hasDups) {
        this.results.packages[packageName].errs.push(`Duplicate keys found in ${file}!`);
      }

      await this.singlePackageHealthCheck(packageName);
    }

    if (this.logResults) {
      console.log(util.inspect(this.results, false, null, true));
    }
    return;
  }

  async singlePackageHealthCheck(packageName) {
    // Preform health check for a singular package
    const pack = this.results.packages[packageName];
    try {
      this.doesPackageHaveEnLocale(pack);
      if (pack.hasEnLocale) {
        // Checks that compare against strings in the locale file require the
        // default locale to check
        this.doesPackageHaveStrayMenus(pack);
        this.doesPackageHaveStrayContextMenus(pack);
        this.doesPackageHaveStrayConfigs(pack);
        this.doesPackageHaveStraySourceStrings(pack);

        // Save for last
        this.findUnusedLocaleStrings(pack);
      } else {
        pack.errs.push("This package has no default 'en' locale, it MUST require one before all checks can run!");
      }

    } catch(err) {
      console.error(packageName);
      console.error(err);
    }

  }

  doesPackageHaveEnLocale(pack) {
    for (const locales in pack.localeFiles) {
      if (locales === "en") {
        pack.hasEnLocale = true;
      }
    }
  }

  findUnusedLocaleStrings(pack) {
    // Iterate through all keypaths to the strings within the default locale file
    // check if any of them don't exist in the string usage report for the package
    const localeFile = pack.localeFiles.en;
    const keyPaths = [];

    const calculateKeyPaths = (obj, parentPath = "") => {
      for (const key in obj) {
        if (typeof obj[key] === "string") {
          // End of a keypath
          let fullKeyPath = parentPath + "." + key;
          fullKeyPath = fullKeyPath.replace(/^\./, ""); // Remove preceeding '.'
          keyPaths.push(fullKeyPath);
        } else {
          calculateKeyPaths(obj[key], parentPath + "." + key);
        }
      }
    };

    calculateKeyPaths(localeFile);

    pack.totalKeyPaths = keyPaths.length;

    // Now with all keypaths, lets see if they are used
    for (const keyPath of keyPaths) {
      if (!pack.usedKeyPaths[keyPath] && !pack.usedKeyPaths[pack.packageJson.name + "." + keyPath]) {
        // We check for the raw keypath, and the keypath including the name, since most often
        // the package name will be present when we collect the keypath in source
        pack.errs.push(`The keypath '${keyPath}' is present in the locale file but never used.`);
      }
    }

  }

  doesPackageHaveStraySourceStrings(pack) {
    // Attempt to find all keypaths used within the source code of a package
    // and determine if any of them are strays
    const ATOMI18N_REG = /atom\.i18n\.t\(['"](?<keyPath>.+?)['"](,(?<args>.+?))?\)/gm;

    const sourceFiles = this.collectStringsFromSource(pack);

    for (const sourceFile in sourceFiles) {
      const apiCalls = sourceFiles[sourceFile].matchAll(ATOMI18N_REG);
      for (const match of apiCalls) {
        const keyPath = match.groups.keyPath;
        const args = match.groups.args;
        this.checkLocaleStringValidity(keyPath, pack);
      }
    }
  }

  collectStringsFromSource(pack) {
    // Attempts to find all keypaths used within the source code of a package
    const packDirs = fs.readdirSync(pack.dir);
    const sourceFilesObj = {};

    const sourceCodeLocations = [ "index.js", "src", "lib" ];

    const collectCodeFromDir = (dir, sourceFiles) => {
      if (fs.lstatSync(dir).isDirectory()) {
        const dirFiles = fs.readdirSync(dir);

        for (let i = 0; i < dirFiles.length; i++) {
          collectCodeFromDir(path.join(dir, dirFiles[i]), sourceFiles);
        }
      } else {
        // Is a file
        const sourceFile = fs.readFileSync(dir, { encoding: "utf-8" });
        sourceFiles[dir] = sourceFile;
      }
    };

    for (let i = 0; i < packDirs.length; i++) {
      if (sourceCodeLocations.includes(packDirs[i])) {
        collectCodeFromDir(path.join(pack.dir, packDirs[i]), sourceFilesObj);
      }
    }

    return sourceFilesObj;
  }

  checkLocaleLabelValidity(rawKeyPath, pack) {
    const keyPath = this.getKeyPathFromLocaleLabel(rawKeyPath);
    this.checkLocaleStringValidity(keyPath, pack);
  }

  checkLocaleStringValidity(keyPath, pack) {
    const keyPathSansPackName = keyPath.replace(/^[^.]+/, "").replace(/^\./, "");
    // ^^^ Remove pack name, since thats only needed when used in Pulsar
    // and is NOT present in the actual locale file
    if (keyPathSansPackName.startsWith("commons")) {
      // commons resources are defined by Pulsar, not the package
      if (this.results.commonsKeyMapsUsed[keyPathSansPackName]) {
        this.results.commonsKeyMapsUsed[keyPathSansPackName] += 1;
      } else {
        this.results.commonsKeyMapsUsed[keyPathSansPackName] = 1;
      }
    } else {
      const translation = keyPathHelpers.getValueAtKeyPath(pack.localeFiles.en, keyPathSansPackName);

      if (translation === undefined) {
        // KeyPathHelpers couldn't locale the keypath
        // Meaning the keypath does NOT exist in the default locale file
        pack.errs.push(`The keypath '${keyPath}' found in '${pack.packageJson.name}' does NOT exist in the default locale file!`);
      } else {
        if (pack.usedKeyPaths[keyPath]) {
          pack.usedKeyPaths[keyPath] += 1;
        } else {
          pack.usedKeyPaths[keyPath] = 1;
        }
      }
    }
  }

  doesPackageHaveStrayConfigs(pack) {
    // Iterate through the config schema of a package, find any LocaleLabels within,
    // then search for them within the locale file, find any missing items
    for (const config in pack.packageJson.configSchema) {
      const title = pack.packageJson.configSchema[config].title ?? null;
      const description = pack.packageJson.configSchema[config].description ?? null;

      if (title && this.isAutoTranslateLabel(title)) {
        this.checkLocaleLabelValidity(title, pack);
      }

      if (description && this.isAutoTranslateLabel(description)) {
        this.checkLocaleLabelValidity(description, pack);
      }

      if (pack.packageJson.configSchema[config].enum) {
        for (let i = 0; i < pack.packageJson.configSchema[config].enum.length; i++) {
          if (this.isAutoTranslateLabel(pack.packageJson.configSchema[config].enum[i].description)) {
            this.checkLocaleLabelValidity(pack.packageJson.configSchema[config].enum[i].description, pack);
          }
        }
      }
    }
  }

  doesPackageHaveStrayMenus(pack) {
    // Iterate through all menu items, find any LocaleLabels within, then search
    // for them within the locale file, find any missing items
    for (const menuPath in pack.menus) {
      const menuFile = pack.menus[menuPath];
      if (!Array.isArray(menuFile.menu)) {
        // This package contains no menus, abort
        continue;
      }
      for (let i = 0; i < menuFile.menu.length; i++) {
        const item = menuFile.menu[i];

        const checkLabels = (menuObj) => {
          if (this.isAutoTranslateLabel(menuObj.label)) {
            this.checkLocaleLabelValidity(menuObj.label, pack);
          }

          if (Array.isArray(menuObj.submenu)) {
            for (let y = 0; y < menuObj.submenu.length; y++) {
              checkLabels(menuObj.submenu[y]);
            }
          }
        };

        checkLabels(item);
      }
    }
  }

  doesPackageHaveStrayContextMenus(pack) {
    // Iterate through all context menu items, find any LocaleLabels within, then
    // search for them within the locale file, find any missing items
    for (const menuPath in pack.menus) {
      const menuFile = pack.menus[menuPath];
      for (const selector in menuFile["context-menu"]) {
        for (let i = 0; i < menuFile["context-menu"][selector].length; i++) {
          if (this.isAutoTranslateLabel(menuFile["context-menu"][selector][i].label)) {
            this.checkLocaleLabelValidity(menuFile["context-menu"][selector][i].label, pack);
          }
        }
      }
    }
  }

  isAutoTranslateLabel(value) {
    return AUTO_TRANSLATE_LABEL.test(value);
  }

  getKeyPathFromLocaleLabel(value) {
    return value.replace(/%/g, "");
  }

  getLocaleFromPath(file) {
    const localeFilePath = file.split(".");
    return localeFilePath[localeFilePath.length - 2] ?? "";
  }

  readLocaleFile(file) {
    return CSON.readFileSync(file);
  }

  doesLocaleHaveDups(file) {
    // The Pulsar I18n API doesn't disallow dups, so this checks for that
    try {
      CSON.readFileSync(file, { allowDuplicateKeys: false });
      return false;
    } catch(err) {
      if (err.message.includes("Duplicate key")) {
        console.error(err);
        return true;
      } else {
        console.error(err);
        return false;
      }
    }
  }

  findPackageMenusFromLocaleFile(file) {
    const menuDir = path.join(file, "../../menus");
    if (!fs.existsSync(menuDir)) {
      return {};
    }

    const menuFiles = fs.readdirSync(menuDir, ['cson', 'json']);

    const menuObj = {};

    for (const menuFile of menuFiles) {
      menuObj[menuFile] = CSON.readFileSync(path.join(menuDir, menuFile));
    }

    return menuObj;
  }

  findPackageNameFromLocaleFile(file) {
    const packageJson = this.findPackageJsonFromLocaleFile(file);
    return packageJson.name ?? UNKNOWN_PACKAGE_ID;
  }

  findPackageJsonFromLocaleFile(file) {
    const packageJsonPath = path.join(file, "../../package.json");

    if (fs.existsSync(packageJsonPath)) {
      const packageJsonData = JSON.parse(fs.readFileSync(packageJsonPath));
      return packageJsonData;
    } else {
      return {};
    }
  }
}
