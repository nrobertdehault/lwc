/* eslint-env node */

const fs = require('fs');
const path = require('path');
const glob = require('glob');

const compiler = require('lwc-compiler');
const pluginUtils = require('rollup-pluginutils');
const lwcNpmResolver = require('lwc-npm-resolver');

// These are transient dependencies that we get from the peer lwc-compiler
const babel = require('babel-core');
const compatPlugin = require('babel-plugin-transform-proxy-compat');

const { DEFAULT_NS, DEFAULT_OPTIONS } = require('./constants');

function getModuleQualifiedName(file, opts) {
    const parts = file.split('/');
    const ext = path.extname(file);
    const fileName = parts.pop();
    let name = path.basename(fileName, ext);
    const nameParts = name.split('-');
    const noNamespace = nameParts.length === 1;
    let isRootEntry;
    let ns;

    // If mapping folder structure override namespace
    if (opts.mapNamespaceFromPath) {
        isRootEntry = name === parts.pop();
        ns = parts.pop();
    } else if (noNamespace) {
        isRootEntry = true;
        ns = DEFAULT_NS;
    } else {
        // This is a hack for integration test package allows cases like test-{name} prefix
        isRootEntry = parts.pop().endsWith(name);

        ns = nameParts.shift();
        name = nameParts.join('-');
    }

    const mappingEntry = `${ns}-${name}`;
    const absoluteFile = path.resolve(process.cwd(), file);
    const root = path.dirname(absoluteFile);

    return {
        name,
        namespace: ns,
        moduleName: isRootEntry ? mappingEntry : `relative::${mappingEntry}`,
        entry: absoluteFile,
    };
}

function getSourceModulePaths(opts, entry) {
    const pathDir = path.dirname(entry);
    const pattern = pathDir + '/**/*.js';
    const mapping = {};

    glob.sync(pattern).forEach(file => {
        const moduleRegistry = getModuleQualifiedName(file, opts);
        mapping[moduleRegistry.moduleName] = moduleRegistry;
    });

    return mapping;
}

module.exports = function rollupRaptorCompiler(opts = {}) {
    const filter = pluginUtils.createFilter(opts.include, opts.exclude);

    const options = Object.assign({}, DEFAULT_OPTIONS, opts, {
        mapNamespaceFromPath: Boolean(opts.mapNamespaceFromPath),
    });

    let modulePaths = {};

    return {
        name: 'rollup-lwc-compiler',

        options(opts) {
            // "entry" options has been rename into "input" with rollup "0.50.0"
            const entry = opts.input || opts.entry;

            const externalPaths = options.resolveFromPackages
                ? lwcNpmResolver()
                : {};
            const sourcePaths = options.resolveFromSource
                ? getSourceModulePaths(options, entry)
                : {};

            modulePaths = Object.assign({}, externalPaths, sourcePaths);
        },

        resolveId(importee, importer) {
            // Resolve entry point if the import references a LWC module
            if (modulePaths[importee]) {
                return modulePaths[importee].entry;
            }

            // Normalize relative import to absolute import
            if (importee.startsWith('.') && importer) {
                const normalizedPath = path.resolve(path.dirname(importer), importee);
                return pluginUtils.addExtension(normalizedPath);
            }
        },

        load(id) {
            const exists = fs.existsSync(id);
            const isCSS = path.extname(id) === '.css';

            if (!exists && isCSS) {
                return '';
            }
        },

        transform(code, id) {
            if (!filter(id)) return;

            // Resolve module definition
            const moduleDefinition = Object.values(modulePaths).find(moduleDef => {
                return id.startsWith(moduleDef.entry);
            }) || getModuleQualifiedName(id, opts);

            return compiler.transform(code, id, {
                moduleName: moduleDefinition.name,
                moduleNamespace: moduleDefinition.namespace,
                mode: options.mode,
                resolveProxyCompat: {
                    global: 'window.Proxy'
                }
            });
        },

        transformBundle(code) {
            return compiler.transformBundle(code, {
                mode: options.mode
            });
        }
    };
};
