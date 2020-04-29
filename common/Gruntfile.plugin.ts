/**
 * Common tasks for plugin publishing and development workflow.
 */

import { execSync, spawnSync } from "child_process";
import { resolve, dirname, basename } from "path";
import { renameSync } from "fs";
import { readFileSync, writeFileSync, lstatSync } from "fs";
import { applyDefaultRunnerConfiguration, hookable } from "./Gruntfile";
import rimraf from "rimraf";
import { extractGlobalStubIdentifiers } from "./php-scope-stub";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const mainPkg = require("../package.json");

function applyPluginRunnerConfiguration(grunt: IGrunt) {
    applyDefaultRunnerConfiguration(grunt);

    grunt.loadNpmTasks("grunt-cachebuster");
    grunt.loadNpmTasks("grunt-node-modules-cachebuster");
    grunt.loadNpmTasks("grunt-contrib-copy");
    grunt.loadNpmTasks("grunt-contrib-clean");
    grunt.loadNpmTasks("grunt-contrib-compress");
    grunt.loadNpmTasks("grunt-strip-code");

    /**
     * Tasks configuration.
     */
    grunt.config.merge({
        BUILD_DIR: "build", // All distribution files
        BUILD_PLUGIN_DIR: "<%= BUILD_DIR %>/<%= pkg.slug %>",
        clean: {
            buildDir: "<%= BUILD_DIR %>/**/*",
            productionSource: {
                expand: true,
                cwd: "<%= BUILD_PLUGIN_DIR %>",
                src: [
                    "public/ts",
                    "public/dev/*.map",
                    "public/dev/i18n-dir/",
                    `vendor/${mainPkg.name}/*/dev/i18n-dir/`,
                    `vendor/${mainPkg.name}/*/dev/*.map`
                ]
            },
            /**
             * Remove all `dev` folders. This is an optional task and must be added via grunt.registerTask("post:clean:productionSource", ["clean:webpackDevBundles"]).
             */
            webpackDevBundles: {
                expand: true,
                cwd: "<%= BUILD_PLUGIN_DIR %>",
                src: ["public/dev/", `vendor/${mainPkg.name}/*/dev/`]
            },
            packageManageFiles: ["<%= BUILD_PLUGIN_DIR %>/?(composer|package).*"]
        },
        strip_code: /* eslint-disable-line @typescript-eslint/camelcase */ {
            /**
             * Clean development source maps.
             */
            productionSource: {
                options: {
                    patterns: /^\/{2}#\s*sourceMappingURL=.*\.map\s*$/gim
                },
                expand: true,
                src: [
                    "<%= BUILD_PLUGIN_DIR %>/public/dev/*.{js,css}",
                    `<%= BUILD_PLUGIN_DIR %>/vendor/${mainPkg.name}/*/dev/*.{js,css}`
                ]
            }
        },
        copy: {
            // Resolve also yarn workspaces hoisting functionality
            npmLibsHoist: ((hoistConfig) => {
                hoistConfig.cwd = "../../node_modules";
                return hoistConfig;
            })({ ...grunt.config.get("copy.npmLibs") }),
            // Source files
            buildSrc: {
                expand: true,
                cwd: "src",
                src: ["**/*", "!**/vendor/**"],
                dest: "<%= BUILD_PLUGIN_DIR %>"
            },
            // Non-src files which also needs to be included into the installable plugin
            buildNonSrc: {
                expand: true,
                src: ["composer.*", "package.json", "LICENSE*", "CHANGELOG.md", "wordpress.org/README.wporg.txt"],
                dest: "<%= BUILD_PLUGIN_DIR %>"
            }
        },
        compress: {
            installablePlugin: {
                options: {
                    archive: "<%= BUILD_DIR %>/<%= pkg.slug %>-<%= pkg.version %>-plugin.zip",
                    level: 9
                },
                expand: true,
                cwd: "<%= BUILD_DIR %>",
                src: "<%= pkg.slug %>/**/*"
            }
        },
        cachebuster: {
            public: {
                options: {
                    banner: `/* This file was automatically generated by the \`grunt libs:cachebuster\` command (${new Date().toString()}). */`,
                    format: "php"
                },
                src: (function () {
                    let src: string[] = [];
                    ["dist", "dev"].forEach((folder) => {
                        src = src.concat([`src/public/${folder}/**/*.js`, `src/public/${folder}/**/*.css`]);
                    });
                    return src;
                })(),
                dest: "src/inc/base/others/cachebuster.php"
            }
        },
        node_modules_cachebuster: /* eslint-disable-line @typescript-eslint/camelcase */ {
            publiclib: {
                options: {
                    banner: `/* This file was automatically generated by the \`grunt libs:cachebuster\` command (${new Date().toString()}). */`,
                    format: "php",
                    altNodeModules: "../../node_modules"
                },
                src: ["src/public/lib/*"],
                dest: "src/inc/base/others/cachebuster-lib.php"
            }
        }
    });

    grunt.registerTask("libs:cachebuster", ["cachebuster:public", "node_modules_cachebuster:publiclib"]);

    grunt.registerTask("libs:copy", [
        "clean:npmLibs",
        "copy:npmLibs",
        "copy:npmLibsHoist",
        "node_modules_cachebuster:publiclib"
    ]);

    grunt.registerTask("composer:install:production", () => {
        const cwd = process.cwd();
        const buildPluginDir = resolve(cwd, grunt.config.get<string>("BUILD_PLUGIN_DIR"));
        const composerJson = resolve(buildPluginDir, "composer.json");
        const lockFile = resolve(buildPluginDir, "composer.lock");
        grunt.log.writeln(`Install no-dev composer dependencies... (BUILD_PLUGIN_DIR=${buildPluginDir})`);

        // Update composer.lock so mirroring is done correctly
        const lock = readFileSync(lockFile)
            .toString()
            .replace(/"symlink": true/gm, `"symlink": false`)
            .replace(/"url": "\.\.\/\.\.\/packages\/(.*)",/gm, `"url": "../../../../packages/$1",`);
        writeFileSync(lockFile, lock);

        // Iterate through dependent packages and temp deactivate their vendor folder for new installation (only non-dev)
        const dependents = Object.keys(JSON.parse(readFileSync(composerJson).toString())["require"] || {})
            .filter((dep) => dep.startsWith(`${mainPkg.name}/`))
            .map((dep) => dep.split("/")[1]);
        dependents.forEach((dep) => {
            grunt.log.writeln(`Temp vendor dir and reinstall non-dev for ${dep}...`);
            const tmpFolder = resolve(cwd, `../../packages/${dep}/vendor-temp`);
            rimraf.sync(tmpFolder);
            renameSync(resolve(cwd, `../../packages/${dep}/vendor`), tmpFolder);
            spawnSync(`composer install --classmap-authoritative --no-dev --no-scripts --prefer-dist`, {
                cwd: resolve(cwd, `../../packages/${dep}`),
                stdio: "inherit",
                shell: true
            });
        });

        // Go, install the main plugin dependencies!
        spawnSync(`composer install --classmap-authoritative --no-dev --no-scripts --prefer-dist`, {
            cwd: buildPluginDir,
            stdio: "inherit",
            shell: true
        });

        // Revert temp vendor
        dependents.forEach((dep) => {
            grunt.log.writeln(`Revert temp vendor dir for ${dep}...`);
            const vendorFolder = resolve(cwd, `../../packages/${dep}/vendor`);
            rimraf.sync(vendorFolder);
            renameSync(resolve(cwd, `../../packages/${dep}/vendor-temp`), vendorFolder);
        });
    });

    /**
     * Build a composer package before it will be installed in a build process.
     */
    grunt.registerTask("composer:dependents:build", () => {
        Object.keys(grunt.config.get<{ [key: string]: string }>("pkg.dependencies"))
            .filter((dep) => dep.indexOf(`@${mainPkg.name}/`) > -1)
            .map((dep) => dep.split("/")[1])
            .forEach((dep) => {
                const cwd = resolve(process.cwd(), `../../packages/${dep}`);
                if (!grunt.file.exists(resolve(cwd, "dist")) || !grunt.file.exists(resolve(cwd, "dev"))) {
                    grunt.log.writeln(`Building production package of ${dep} in ${cwd}...`);
                    execSync(`cd '${cwd}' && yarn build`, { stdio: "inherit" }); // we can not use `cwd` as option because yarn can not resolve packages then
                }
            });
    });

    /**
     * Composer does not allow to define to pack only a set of directories and files as yarn
     * allows with package.json#files (https://stackoverflow.com/a/17069547/5506547). For this, a
     * custom implementation in composer.json#extra.copy-all-except is implemented.
     */
    grunt.registerTask("composer:clean:production", () => {
        const buildPluginDir = grunt.config.get<string>("BUILD_PLUGIN_DIR");
        const onlyThis = ["composer.*", "package.json", "LICENSE*", "README*", "CHANGELOG*"];
        grunt.file.expand({ cwd: buildPluginDir }, `vendor/${mainPkg.name}/*/composer.json`).forEach((file) => {
            const absolute = resolve(buildPluginDir, file);
            grunt.log.writeln(`Read composer file for local dependant ${absolute}...`);
            const content = grunt.file.readJSON(absolute);

            const files = content?.extra?.["clean-all-except"];
            if (files) {
                // Delete all files except the defined one
                const cwd = dirname(absolute);
                const del = [...onlyThis, ...files];

                // Expand directories
                del.forEach((folder) => {
                    try {
                        if (lstatSync(resolve(cwd, folder)).isDirectory()) {
                            del.push(`${folder}/**/*`);
                        }
                    } catch (e) {
                        // Silence is golden.
                    }
                });

                // Delete static folders
                grunt.file.delete(resolve(cwd, "node_modules"));
                grunt.file.delete(resolve(cwd, ".yarn"));

                // Diff keep and delete
                const keep = grunt.file.expand({ cwd }, del);
                grunt.file
                    .expand({ cwd }, ["**/*", "!**/vendor/**"])
                    .filter((file) => keep.indexOf(file) === -1)
                    .map((file) => resolve(cwd, file))
                    .forEach((file) => grunt.file.exists(file) && grunt.file.delete(file));
            }
        });
    });

    /**
     * Some files are copied wrongly because copy:buildNonSrc is using the `expand` option so
     * e. g. `wordpress.org` is created as folder but the file inside should be moved.
     */
    grunt.registerTask("build:post", () => {
        const buildPluginDir = grunt.config.get("BUILD_PLUGIN_DIR");

        // Movements
        grunt.file.copy(`${buildPluginDir}/wordpress.org/README.wporg.txt`, `${buildPluginDir}/README.wporg.txt`);

        // Deletions
        grunt.file.delete(`${buildPluginDir}/wordpress.org`);
    });

    /**
     * Scope our PHP plugin. See also php-scoper.php.
     *
     * @see https://github.com/humbug/php-scoper
     */
    grunt.registerTask("php:scope", () => {
        const cwd = process.cwd();
        const buildPluginDir = resolve(grunt.config.get<string>("BUILD_PLUGIN_DIR"));
        const configFile = resolve("../../common/php-scoper.php");
        const outputDir = `${buildPluginDir}-scoped`;
        const tmpStubFile = resolve(buildPluginDir, "php-scoper.php.json");

        // Whitelist stubs, write them to a temporary file so php-scoper.php can consume it
        const stubPathes = grunt.config.get<string[]>("pkg.stubs").map((relative) => resolve(cwd, relative));
        const addOnPathes = grunt.file
            .expand(
                {
                    cwd: resolve("../")
                },
                ["*/src/inc/**/*.php", `!${basename(cwd)}/**/*`]
            )
            .map((relative) => resolve("..", relative));
        const apiPathes = grunt.file
            .expand(
                {
                    cwd: resolve("../")
                },
                "*/src/inc/api/**/*.php"
            )
            .map((relative) => resolve("..", relative));
        const whitelist = extractGlobalStubIdentifiers(stubPathes.concat(addOnPathes, apiPathes));
        writeFileSync(tmpStubFile, JSON.stringify(whitelist), {
            encoding: "UTF-8"
        });

        // Execute the php-scoper
        spawnSync(`php-scoper add-prefix --output-dir="${outputDir}" --config "${configFile}"`, {
            cwd: buildPluginDir,
            stdio: "inherit",
            shell: true
        });

        // Overwrite back all scoped files to main directory
        grunt.file
            .expand(
                {
                    cwd: outputDir,
                    filter: "isFile"
                },
                "**/*"
            )
            .forEach((relative) => renameSync(resolve(outputDir, relative), resolve(buildPluginDir, relative)));

        // It is essential to reload the autoloader files
        const rebuildAutoloader = (cwd: string) =>
            spawnSync(`composer dump-autoload --classmap-authoritative`, {
                cwd,
                stdio: "inherit",
                shell: true
            });
        grunt.file
            .expand(
                {
                    cwd: buildPluginDir,
                    filter: "isDirectory"
                },
                "vendor/*/*"
            )
            .forEach((folder) => rebuildAutoloader(resolve(buildPluginDir, folder)));
        rebuildAutoloader(buildPluginDir);

        rimraf.sync(outputDir);
        rimraf.sync(tmpStubFile);
    });

    /**
     * Build the whole plugin to the distribution files.
     */
    grunt.registerTask(
        "build",
        hookable(
            grunt,
            [
                "clean:buildDir",
                "libs:copy",
                "libs:cachebuster",
                "yarn:disclaimer",
                "composer:disclaimer",
                "copy:buildSrc",
                "copy:buildNonSrc",
                "build:post",
                "clean:productionLibs",
                "strip_code:sourcemaps",
                "build:readme",
                "composer:dependents:build",
                "composer:install:production",
                "composer:clean:production",
                "clean:productionSource",
                "strip_code:productionSource",
                "php:scope",
                "clean:packageManageFiles"
            ].concat(grunt.config.get("BUILD_POST_TASKS") || [])
        )
    );

    /**
     * Versioning task that modifies the index.php file and reflects the same version
     * as in package.json.
     */
    grunt.registerTask("postversion", () => {
        const version = grunt.config.get("pkg.version");
        const indexphp = grunt.file.read("src/index.php");
        const newindexphp = indexphp.replace(/Version:(\s*)(.*)$/gm, `Version:$1${version}`);
        grunt.file.write("src/index.php", newindexphp);
        grunt.log.oklns(`Wrote src/index.php ${version}`);

        // If we run in lerna context add it to the staged files (see https://git.io/JewXM)
        if (/lerna/.test(process.env.npm_execpath)) {
            const indexphpPath = resolve("src/index.php");
            grunt.log.writeln(`Git stage ${indexphpPath}`);
            const add = execSync(`git add '${indexphpPath}'`);
            grunt.log.writeln(add.toString());
        }
    });

    /**
     * Generate the README.txt from README.wporg.txt and allow includes through
     * the [include:filename] syntax so wordpress.org can consume it.
     */
    grunt.registerTask("build:readme", () => {
        const buildPluginDir = grunt.config.get("BUILD_PLUGIN_DIR");
        let publicTxt = grunt.file.read(`${buildPluginDir}/README.wporg.txt`);
        publicTxt = publicTxt.replace(/\[include:([^\]:]+)\]/g, (matched, filename) => {
            if (grunt.file.exists(`${buildPluginDir}/${filename}`)) {
                let content = grunt.file.read(`${buildPluginDir}/${filename}`);
                if (filename === "CHANGELOG.md") {
                    // Further changelog refactors...
                    // 1. Remove title (https://regex101.com/r/fEBgwx/1)
                    content = content.replace(/^# Change Log.*?(# \d+\.)/gms, "$1");

                    // 2. Remove types (https://regex101.com/r/fEBgwx/2)
                    content = content.replace(/### (?!feat|fix|perf|docs)\w+\n(.*?)\n\n\n/gms, "");

                    // 3. Remove empty lines (https://regex101.com/r/fEBgwx/3)
                    content = content.replace(/^(?:[\t ]*(?:\r?\n|\r))+/gms, "\n");
                }
                return content;
            }
            return matched;
        });
        grunt.file.write(`${buildPluginDir}/README.txt`, publicTxt);
        grunt.file.delete(`${buildPluginDir}/README.wporg.txt`);
    });

    /**
     * Rename README.md to README.txt so it can be consumed by wordpress.org. This task
     * is replaced by build:readme and is only here for legacy purposes (legacy branch).
     *
     * @legacy
     */
    grunt.registerTask("serveRenameReadme", () => {
        const buildPluginDir = grunt.config.get("BUILD_PLUGIN_DIR");
        grunt.file.copy(`${buildPluginDir}/README.md`, `${buildPluginDir}/README.txt`);
        grunt.file.delete(`${buildPluginDir}/README.md`);
    });
}

export { applyPluginRunnerConfiguration };
