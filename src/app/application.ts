import * as fs from 'fs-extra';
import * as path from 'path';
import * as LiveServer from 'live-server';
import * as Shelljs from 'shelljs';
import * as _ from 'lodash';
import * as ts from 'typescript';
import * as glob from 'glob';

const chokidar = require('chokidar');
const marked = require('marked');

import { logger } from '../logger';
import { HtmlEngine } from './engines/html.engine';
import { MarkdownEngine } from './engines/markdown.engine';
import { FileEngine } from './engines/file.engine';
import { Configuration } from './configuration';
import { ConfigurationInterface } from './interfaces/configuration.interface';
import { NgdEngine } from './engines/ngd.engine';
import { SearchEngine } from './engines/search.engine';
import { ExportEngine } from './engines/export.engine';
import { CoverageEngine } from './engines/coverage-report.engine';
import { Dependencies } from './compiler/dependencies';

import { COMPODOC_DEFAULTS } from '../utils/defaults';

import { cleanSourcesForWatch } from '../utils/utils';

import { cleanNameWithoutSpaceAndToLowerCase, findMainSourceFolder } from '../utilities';

import { promiseSequential } from '../utils/promise-sequential';
import { DependenciesEngine } from './engines/dependencies.engine';
import { AngularVersionUtil, RouterParserUtil } from '../utils';

let pkg = require('../package.json');
let cwd = process.cwd();
let $markdownengine = new MarkdownEngine();
let startTime = new Date();
let generationPromiseResolve;
let generationPromiseReject;
let generationPromise = new Promise((resolve, reject) => {
    generationPromiseResolve = resolve;
    generationPromiseReject = reject;
});

export class Application {
    /**
     * Files processed during initial scanning
     */
    public files: Array<string>;
    /**
     * Files processed during watch scanning
     */
    public updatedFiles: Array<string>;
    /**
     * Files changed during watch scanning
     */
    public watchChangedFiles: Array<string> = [];
    /**
     * Compodoc configuration local reference
     */
    public configuration: ConfigurationInterface;
    /**
     * Boolean for watching status
     * @type {boolean}
     */
    public isWatching: boolean = false;

    private angularVersionUtil = new AngularVersionUtil();
    private dependenciesEngine: DependenciesEngine;
    private ngdEngine: NgdEngine;
    private htmlEngine: HtmlEngine;
    private searchEngine: SearchEngine;
    private exportEngine: ExportEngine;
    private coverageEngine: CoverageEngine;
    protected fileEngine: FileEngine = new FileEngine();
    private routerParser = new RouterParserUtil();

    /**
     * Create a new compodoc application instance.
     *
     * @param options An object containing the options that should be used.
     */
    constructor(options?: Object) {
        this.configuration = new Configuration();
        this.dependenciesEngine = new DependenciesEngine();
        this.ngdEngine = new NgdEngine(this.dependenciesEngine);
        this.htmlEngine = new HtmlEngine(this.configuration, this.dependenciesEngine, this.fileEngine);
        this.searchEngine = new SearchEngine(this.configuration, this.fileEngine);
        this.coverageEngine = new CoverageEngine(this.configuration, this.dependenciesEngine, this.fileEngine, this.htmlEngine);
        this.exportEngine = new ExportEngine(this.configuration, this.dependenciesEngine, this.fileEngine, this.coverageEngine);

        for (let option in options) {
            if (typeof this.configuration.mainData[option] !== 'undefined') {
                this.configuration.mainData[option] = options[option];
            }
            // For documentationMainName, process it outside the loop, for handling conflict with pages name
            if (option === 'name') {
                this.configuration.mainData.documentationMainName = options[option];
            }
            // For documentationMainName, process it outside the loop, for handling conflict with pages name
            if (option === 'silent') {
                logger.silent = false;
            }
        }
    }

    /**
     * Start compodoc process
     */
    protected generate() {

        process.on('unhandledRejection', this.unhandledRejectionListener);
        process.on('uncaughtException', this.uncaughtExceptionListener);

        if (this.configuration.mainData.output.charAt(this.configuration.mainData.output.length - 1) !== '/') {
            this.configuration.mainData.output += '/';
        }

        if (this.configuration.mainData.exportFormat !== COMPODOC_DEFAULTS.exportFormat) {
            this.processPackageJson();
        } else {
            this.htmlEngine.init()
                .then(() => this.processPackageJson());
        }
        return generationPromise;
    }

    private endCallback() {
        process.removeListener('unhandledRejection', this.unhandledRejectionListener);
        process.removeListener('uncaughtException', this.uncaughtExceptionListener);
    }

    private unhandledRejectionListener(err, p) {
        console.log('Unhandled Rejection at:', p, 'reason:', err);
        logger.error('Sorry, but there was a problem during parsing or generation of the documentation. Please fill an issue on github. (https://github.com/compodoc/compodoc/issues/new)');
        process.exit(1);
    }

    private uncaughtExceptionListener(err) {
        logger.error(err);
        logger.error('Sorry, but there was a problem during parsing or generation of the documentation. Please fill an issue on github. (https://github.com/compodoc/compodoc/issues/new)');
        process.exit(1);
    }

    /**
     * Start compodoc documentation coverage
     */
    protected testCoverage() {
        this.getDependenciesData();
    }

    /**
     * Store files for initial processing
     * @param  {Array<string>} files Files found during source folder and tsconfig scan
     */
    public setFiles(files: Array<string>) {
        this.files = files;
    }

    /**
     * Store files for watch processing
     * @param  {Array<string>} files Files found during source folder and tsconfig scan
     */
    public setUpdatedFiles(files: Array<string>) {
        this.updatedFiles = files;
    }

    /**
     * Return a boolean indicating presence of one TypeScript file in updatedFiles list
     * @return {boolean} Result of scan
     */
    public hasWatchedFilesTSFiles(): boolean {
        let result = false;

        _.forEach(this.updatedFiles, (file) => {
            if (path.extname(file) === '.ts') {
                result = true;
            }
        });

        return result;
    }

    /**
     * Return a boolean indicating presence of one root markdown files in updatedFiles list
     * @return {boolean} Result of scan
     */
    public hasWatchedFilesRootMarkdownFiles(): boolean {
        let result = false;

        _.forEach(this.updatedFiles, (file) => {
            if (path.extname(file) === '.md' && path.dirname(file) === process.cwd()) {
                result = true;
            }
        });

        return result;
    }

    /**
     * Clear files for watch processing
     */
    public clearUpdatedFiles(): void {
        this.updatedFiles = [];
        this.watchChangedFiles = [];
    }

    private processPackageJson(): void {
        logger.info('Searching package.json file');
        this.fileEngine.get(process.cwd() + path.sep + 'package.json').then((packageData) => {
            let parsedData = JSON.parse(packageData);
            if (typeof parsedData.name !== 'undefined' && this.configuration.mainData.documentationMainName === COMPODOC_DEFAULTS.title) {
                this.configuration.mainData.documentationMainName = parsedData.name + ' documentation';
            }
            if (typeof parsedData.description !== 'undefined') {
                this.configuration.mainData.documentationMainDescription = parsedData.description;
            }
            this.configuration.mainData.angularVersion = this.angularVersionUtil.getAngularVersionOfProject(parsedData);
            logger.info('package.json file found');
            this.processMarkdowns().then(() => {
                this.getDependenciesData();
            }, (errorMessage) => {
                logger.error(errorMessage);
            });
        }, (errorMessage) => {
            logger.error(errorMessage);
            logger.error('Continuing without package.json file');
            this.processMarkdowns().then(() => {
                this.getDependenciesData();
            }, (errorMessage1) => {
                logger.error(errorMessage1);
            });
        });
    }

    private processMarkdowns(): Promise<any> {
        logger.info('Searching README.md, CHANGELOG.md, CONTRIBUTING.md, LICENSE.md, TODO.md files');

        return new Promise((resolve, reject) => {
            let i = 0;
            let markdowns = ['readme', 'changelog', 'contributing', 'license', 'todo'];
            let numberOfMarkdowns = 5;
            let loop = () => {
                if (i < numberOfMarkdowns) {
                    $markdownengine.getTraditionalMarkdown(markdowns[i].toUpperCase()).then((readmeData: string) => {
                        this.configuration.addPage({
                            name: (markdowns[i] === 'readme') ? 'index' : markdowns[i],
                            context: 'getting-started',
                            id: 'getting-started',
                            markdown: readmeData,
                            depth: 0,
                            pageType: COMPODOC_DEFAULTS.PAGE_TYPES.ROOT
                        });
                        if (markdowns[i] === 'readme') {
                            this.configuration.mainData.readme = true;
                            this.configuration.addPage({
                                name: 'overview',
                                id: 'overview',
                                context: 'overview',
                                pageType: COMPODOC_DEFAULTS.PAGE_TYPES.ROOT
                            });
                        } else {
                            this.configuration.mainData.markdowns.push({
                                name: markdowns[i],
                                uppername: markdowns[i].toUpperCase(),
                                depth: 0,
                                pageType: COMPODOC_DEFAULTS.PAGE_TYPES.ROOT
                            });
                        }
                        logger.info(`${markdowns[i].toUpperCase()}.md file found`);
                        i++;
                        loop();
                    }, (errorMessage) => {
                        logger.warn(errorMessage);
                        logger.warn(`Continuing without ${markdowns[i].toUpperCase()}.md file`);
                        if (markdowns[i] === 'readme') {
                            this.configuration.addPage({
                                name: 'index',
                                id: 'index',
                                context: 'overview'
                            });
                        }
                        i++;
                        loop();
                    });
                } else {
                    resolve();
                }
            };
            loop();
        });
    }

    private rebuildRootMarkdowns(): void {
        logger.info('Regenerating README.md, CHANGELOG.md, CONTRIBUTING.md, LICENSE.md, TODO.md pages');

        let actions = [];

        this.configuration.resetRootMarkdownPages();

        actions.push(() => { return this.processMarkdowns(); });

        promiseSequential(actions)
            .then(res => {
                this.processPages();
                this.clearUpdatedFiles();
            })
            .catch(errorMessage => {
                logger.error(errorMessage);
            });
    }

    /**
     * Get dependency data for small group of updated files during watch process
     */
    private getMicroDependenciesData(): void {
        logger.info('Get diff dependencies data');
        let crawler = new Dependencies(
            this.updatedFiles, {
                tsconfigDirectory: path.dirname(this.configuration.mainData.tsconfig)
            },
            this.configuration,
            this.routerParser
        );

        let dependenciesData = crawler.getDependencies();

        this.dependenciesEngine.update(dependenciesData);

        this.prepareJustAFewThings(dependenciesData);
    }

    /**
     * Rebuild external documentation during watch process
     */
    private rebuildExternalDocumentation(): void {
        logger.info('Rebuild external documentation');

        let actions = [];

        this.configuration.resetAdditionalPages();

        if (this.configuration.mainData.includes !== '') {
            actions.push(() => { return this.prepareExternalIncludes(); });
        }

        promiseSequential(actions)
            .then(res => {
                this.processPages();
                this.clearUpdatedFiles();
            })
            .catch(errorMessage => {
                logger.error(errorMessage);
            });
    }

    private getDependenciesData(): void {
        logger.info('Get dependencies data');

        let crawler = new Dependencies(
            this.files, {
                tsconfigDirectory: path.dirname(this.configuration.mainData.tsconfig)
            },
            this.configuration,
            this.routerParser
        );

        let dependenciesData = crawler.getDependencies();

        this.dependenciesEngine.init(dependenciesData);

        this.configuration.mainData.routesLength = this.routerParser.routesLength();

        this.printStatistics();

        this.prepareEverything();
    }

    private prepareJustAFewThings(diffCrawledData): void {
        let actions = [];

        this.configuration.resetPages();

        actions.push(() => this.prepareRoutes());

        if (diffCrawledData.modules.length > 0) {
            actions.push(() => this.prepareModules());
        }
        if (diffCrawledData.components.length > 0) {
            actions.push(() => this.prepareComponents());
        }

        if (diffCrawledData.directives.length > 0) {
            actions.push(() => this.prepareDirectives());
        }

        if (diffCrawledData.injectables.length > 0) {
            actions.push(() => this.prepareInjectables());
        }

        if (diffCrawledData.pipes.length > 0) {
            actions.push(() => this.preparePipes());
        }

        if (diffCrawledData.classes.length > 0) {
            actions.push(() => this.prepareClasses());
        }

        if (diffCrawledData.interfaces.length > 0) {
            actions.push(() => this.prepareInterfaces());
        }

        if (diffCrawledData.miscellaneous.variables.length > 0 ||
            diffCrawledData.miscellaneous.functions.length > 0 ||
            diffCrawledData.miscellaneous.typealiases.length > 0 ||
            diffCrawledData.miscellaneous.enumerations.length > 0) {
            actions.push(() => this.prepareMiscellaneous());
        }

        if (!this.configuration.mainData.disableCoverage) {
            actions.push(() => this.prepareCoverage());
        }

        promiseSequential(actions)
            .then(res => {
                this.processGraphs();
                this.clearUpdatedFiles();
            })
            .catch(errorMessage => {
                logger.error(errorMessage);
            });
    }

    private printStatistics() {
        logger.info('-------------------');
        logger.info('Project statistics ');
        if (this.dependenciesEngine.modules.length > 0) {
            logger.info(`- module     : ${this.dependenciesEngine.modules.length}`);
        }
        if (this.dependenciesEngine.components.length > 0) {
            logger.info(`- component  : ${this.dependenciesEngine.components.length}`);
        }
        if (this.dependenciesEngine.directives.length > 0) {
            logger.info(`- directive  : ${this.dependenciesEngine.directives.length}`);
        }
        if (this.dependenciesEngine.injectables.length > 0) {
            logger.info(`- injectable : ${this.dependenciesEngine.injectables.length}`);
        }
        if (this.dependenciesEngine.pipes.length > 0) {
            logger.info(`- pipe       : ${this.dependenciesEngine.pipes.length}`);
        }
        if (this.dependenciesEngine.classes.length > 0) {
            logger.info(`- class      : ${this.dependenciesEngine.classes.length}`);
        }
        if (this.dependenciesEngine.interfaces.length > 0) {
            logger.info(`- interface  : ${this.dependenciesEngine.interfaces.length}`);
        }
        if (this.configuration.mainData.routesLength > 0) {
            logger.info(`- route      : ${this.configuration.mainData.routesLength}`);
        }
        logger.info('-------------------');
    }

    private prepareEverything() {
        let actions = [];

        actions.push(() => { return this.prepareModules(); });
        actions.push(() => { return this.prepareComponents(); });

        if (this.dependenciesEngine.directives.length > 0) {
            actions.push(() => { return this.prepareDirectives(); });
        }

        if (this.dependenciesEngine.injectables.length > 0) {
            actions.push(() => { return this.prepareInjectables(); });
        }

        if (this.dependenciesEngine.routes && this.dependenciesEngine.routes.children.length > 0) {
            actions.push(() => { return this.prepareRoutes(); });
        }

        if (this.dependenciesEngine.pipes.length > 0) {
            actions.push(() => { return this.preparePipes(); });
        }

        if (this.dependenciesEngine.classes.length > 0) {
            actions.push(() => { return this.prepareClasses(); });
        }

        if (this.dependenciesEngine.interfaces.length > 0) {
            actions.push(() => { return this.prepareInterfaces(); });
        }

        if (this.dependenciesEngine.miscellaneous.variables.length > 0 ||
            this.dependenciesEngine.miscellaneous.functions.length > 0 ||
            this.dependenciesEngine.miscellaneous.typealiases.length > 0 ||
            this.dependenciesEngine.miscellaneous.enumerations.length > 0) {
            actions.push(() => { return this.prepareMiscellaneous(); });
        }

        if (!this.configuration.mainData.disableCoverage) {
            actions.push(() => { return this.prepareCoverage(); });
        }

        if (this.configuration.mainData.includes !== '') {
            actions.push(() => { return this.prepareExternalIncludes(); });
        }

        promiseSequential(actions)
            .then(res => {
                if (this.configuration.mainData.exportFormat !== COMPODOC_DEFAULTS.exportFormat) {
                    if (COMPODOC_DEFAULTS.exportFormatsSupported.indexOf(this.configuration.mainData.exportFormat) > -1) {
                        logger.info(`Generating documentation in export format ${this.configuration.mainData.exportFormat}`);
                        this.exportEngine.export(this.configuration.mainData.output, this.configuration.mainData).then(() => {
                            let finalTime = (new Date() - startTime) / 1000;
                            generationPromiseResolve();
                            this.endCallback();
                            logger.info('Documentation generated in ' + this.configuration.mainData.output +
                                ' in ' + finalTime + ' seconds');
                        });
                    } else {
                        logger.warn(`Exported format not supported`);
                    }
                } else {
                    this.processGraphs();
                }
            })
            .catch(errorMessage => {
                logger.error(errorMessage);
            });
    }

    private prepareExternalIncludes() {
        logger.info('Adding external markdown files');
        // Scan include folder for files detailed in summary.json
        // For each file, add to this.configuration.mainData.additionalPages
        // Each file will be converted to html page, inside COMPODOC_DEFAULTS.additionalEntryPath
        return new Promise((resolve, reject) => {
            this.fileEngine.get(process.cwd() + path.sep + this.configuration.mainData.includes + path.sep + 'summary.json')
                .then((summaryData) => {
                    logger.info('Additional documentation: summary.json file found');

                    let parsedSummaryData = JSON.parse(summaryData);
                    let i = 0;
                    let len = parsedSummaryData.length;
                    let loop = () => {
                        if (i <= len - 1) {
                            $markdownengine.getTraditionalMarkdown(this.configuration.mainData.includes + path.sep + parsedSummaryData[i].file)
                                .then((markedData) => {
                                    this.configuration.addAdditionalPage({
                                        name: parsedSummaryData[i].title,
                                        id: parsedSummaryData[i].title,
                                        filename: cleanNameWithoutSpaceAndToLowerCase(parsedSummaryData[i].title),
                                        context: 'additional-page',
                                        path: this.configuration.mainData.includesFolder,
                                        additionalPage: markedData,
                                        depth: 1,
                                        pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                                    });

                                    if (parsedSummaryData[i].children && parsedSummaryData[i].children.length > 0) {
                                        let j = 0;
                                        let leng = parsedSummaryData[i].children.length;
                                        let loopChild = () => {
                                            if (j <= leng - 1) {
                                                $markdownengine
                                                    .getTraditionalMarkdown(this.configuration.mainData.includes + path.sep + parsedSummaryData[i].children[j].file)
                                                    .then((markedData) => {
                                                        this.configuration.addAdditionalPage({
                                                            name: parsedSummaryData[i].children[j].title,
                                                            id: parsedSummaryData[i].children[j].title,
                                                            filename: cleanNameWithoutSpaceAndToLowerCase(parsedSummaryData[i].children[j].title),
                                                            context: 'additional-page',
                                                            path: this.configuration.mainData.includesFolder + '/' + cleanNameWithoutSpaceAndToLowerCase(parsedSummaryData[i].title),
                                                            additionalPage: markedData,
                                                            depth: 2,
                                                            pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                                                        });
                                                        j++;
                                                        loopChild();
                                                    }, (e) => {
                                                        logger.error(e);
                                                    });
                                            } else {
                                                i++;
                                                loop();
                                            }
                                        };
                                        loopChild();
                                    } else {
                                        i++;
                                        loop();
                                    }
                                }, (e) => {
                                    logger.error(e);
                                });
                        } else {
                            resolve();
                        }
                    };
                    loop();
                }, (errorMessage) => {
                    logger.error(errorMessage);
                    reject('Error during Additional documentation generation');
                });
        });
    }

    public prepareModules(someModules?): Promise<any> {
        logger.info('Prepare modules');
        let i = 0;
        let _modules = (someModules) ? someModules : this.dependenciesEngine.getModules();

        return new Promise((resolve, reject) => {

            this.configuration.mainData.modules = _modules.map(ngModule => {
                ['declarations', 'bootstrap', 'imports', 'exports'].forEach(metadataType => {
                    ngModule[metadataType] = ngModule[metadataType].filter(metaDataItem => {
                        switch (metaDataItem.type) {
                            case 'directive':
                                return this.dependenciesEngine.getDirectives().some(directive => directive.name === metaDataItem.name);

                            case 'component':
                                return this.dependenciesEngine.getComponents().some(component => component.name === metaDataItem.name);

                            case 'module':
                                return this.dependenciesEngine.getModules().some(module => module.name === metaDataItem.name);

                            case 'pipe':
                                return this.dependenciesEngine.getPipes().some(pipe => pipe.name === metaDataItem.name);

                            default:
                                return true;
                        }
                    });
                });
                ngModule.providers = ngModule.providers.filter(provider => {
                    return this.dependenciesEngine.getInjectables().some(injectable => injectable.name === provider.name);
                });
                return ngModule;
            });
            this.configuration.addPage({
                name: 'modules',
                id: 'modules',
                context: 'modules',
                depth: 0,
                pageType: COMPODOC_DEFAULTS.PAGE_TYPES.ROOT
            });

            let len = this.configuration.mainData.modules.length;
            let loop = () => {
                if (i < len) {
                    if ($markdownengine.hasNeighbourReadmeFile(this.configuration.mainData.modules[i].file)) {
                        logger.info(` ${this.configuration.mainData.modules[i].name} has a README file, include it`);
                        let readme = $markdownengine.readNeighbourReadmeFile(this.configuration.mainData.modules[i].file);
                        this.configuration.mainData.modules[i].readme = marked(readme);
                    }
                    this.configuration.addPage({
                        path: 'modules',
                        name: this.configuration.mainData.modules[i].name,
                        id: this.configuration.mainData.modules[i].id,
                        context: 'module',
                        module: this.configuration.mainData.modules[i],
                        depth: 1,
                        pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                    });
                    i++;
                    loop();
                } else {
                    resolve();
                }
            };
            loop();
        });
    }

    public preparePipes = (somePipes?) => {
        logger.info('Prepare pipes');
        this.configuration.mainData.pipes = (somePipes) ? somePipes : this.dependenciesEngine.getPipes();

        return new Promise((resolve, reject) => {
            let i = 0;
            let len = this.configuration.mainData.pipes.length;
            let loop = () => {
                if (i < len) {
                    if ($markdownengine.hasNeighbourReadmeFile(this.configuration.mainData.pipes[i].file)) {
                        logger.info(` ${this.configuration.mainData.pipes[i].name} has a README file, include it`);
                        let readme = $markdownengine.readNeighbourReadmeFile(this.configuration.mainData.pipes[i].file);
                        this.configuration.mainData.pipes[i].readme = marked(readme);
                    }
                    this.configuration.addPage({
                        path: 'pipes',
                        name: this.configuration.mainData.pipes[i].name,
                        id: this.configuration.mainData.pipes[i].id,
                        context: 'pipe',
                        pipe: this.configuration.mainData.pipes[i],
                        depth: 1,
                        pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                    });
                    i++;
                    loop();
                } else {
                    resolve();
                }
            };
            loop();
        });
    }

    public prepareClasses = (someClasses?) => {
        logger.info('Prepare classes');
        this.configuration.mainData.classes = (someClasses) ? someClasses : this.dependenciesEngine.getClasses();

        return new Promise((resolve, reject) => {
            let i = 0;
            let len = this.configuration.mainData.classes.length;
            let loop = () => {
                if (i < len) {
                    if ($markdownengine.hasNeighbourReadmeFile(this.configuration.mainData.classes[i].file)) {
                        logger.info(` ${this.configuration.mainData.classes[i].name} has a README file, include it`);
                        let readme = $markdownengine.readNeighbourReadmeFile(this.configuration.mainData.classes[i].file);
                        this.configuration.mainData.classes[i].readme = marked(readme);
                    }
                    this.configuration.addPage({
                        path: 'classes',
                        name: this.configuration.mainData.classes[i].name,
                        id: this.configuration.mainData.classes[i].id,
                        context: 'class',
                        class: this.configuration.mainData.classes[i],
                        depth: 1,
                        pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                    });
                    i++;
                    loop();
                } else {
                    resolve();
                }
            };
            loop();
        });
    }

    public prepareInterfaces(someInterfaces?) {
        logger.info('Prepare interfaces');
        this.configuration.mainData.interfaces = (someInterfaces) ? someInterfaces : this.dependenciesEngine.getInterfaces();

        return new Promise((resolve, reject) => {
            let i = 0;
            let len = this.configuration.mainData.interfaces.length;
            let loop = () => {
                if (i < len) {
                    if ($markdownengine.hasNeighbourReadmeFile(this.configuration.mainData.interfaces[i].file)) {
                        logger.info(` ${this.configuration.mainData.interfaces[i].name} has a README file, include it`);
                        let readme = $markdownengine.readNeighbourReadmeFile(this.configuration.mainData.interfaces[i].file);
                        this.configuration.mainData.interfaces[i].readme = marked(readme);
                    }
                    this.configuration.addPage({
                        path: 'interfaces',
                        name: this.configuration.mainData.interfaces[i].name,
                        id: this.configuration.mainData.interfaces[i].id,
                        context: 'interface',
                        interface: this.configuration.mainData.interfaces[i],
                        depth: 1,
                        pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                    });
                    i++;
                    loop();
                } else {
                    resolve();
                }
            };
            loop();
        });
    }

    public prepareMiscellaneous(someMisc?) {
        logger.info('Prepare miscellaneous');
        this.configuration.mainData.miscellaneous = (someMisc) ? someMisc : this.dependenciesEngine.getMiscellaneous();

        return new Promise((resolve, reject) => {

            if (this.configuration.mainData.miscellaneous.functions.length > 0) {
                this.configuration.addPage({
                    path: 'miscellaneous',
                    name: 'functions',
                    id: 'miscellaneous-functions',
                    context: 'miscellaneous-functions',
                    depth: 1,
                    pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                });
            }
            if (this.configuration.mainData.miscellaneous.variables.length > 0) {
                this.configuration.addPage({
                    path: 'miscellaneous',
                    name: 'variables',
                    id: 'miscellaneous-variables',
                    context: 'miscellaneous-variables',
                    depth: 1,
                    pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                });
            }
            if (this.configuration.mainData.miscellaneous.typealiases.length > 0) {
                this.configuration.addPage({
                    path: 'miscellaneous',
                    name: 'typealiases',
                    id: 'miscellaneous-typealiases',
                    context: 'miscellaneous-typealiases',
                    depth: 1,
                    pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                });
            }
            if (this.configuration.mainData.miscellaneous.enumerations.length > 0) {
                this.configuration.addPage({
                    path: 'miscellaneous',
                    name: 'enumerations',
                    id: 'miscellaneous-enumerations',
                    context: 'miscellaneous-enumerations',
                    depth: 1,
                    pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                });
            }

            resolve();
        });
    }

    private handleTemplateurl(component): Promise<any> {
        let dirname = path.dirname(component.file);
        let templatePath = path.resolve(dirname + path.sep + component.templateUrl);

        if (!this.fileEngine.existsSync(templatePath)) {
            let err = `Cannot read template for ${component.name}`;
            logger.error(err);
            return new Promise((resolve, reject) => { });
        }

        return this.fileEngine.get(templatePath)
            .then(data => component.templateData = data,
            err => {
                logger.error(err);
                return Promise.reject('');
            });
    }

    public prepareComponents(someComponents?) {
        logger.info('Prepare components');
        this.configuration.mainData.components = (someComponents) ? someComponents : this.dependenciesEngine.getComponents();

        return new Promise((mainResolve, reject) => {
            let i = 0;
            let len = this.configuration.mainData.components.length;
            let loop = () => {
                if (i <= len - 1) {
                    if ($markdownengine.hasNeighbourReadmeFile(this.configuration.mainData.components[i].file)) {
                        logger.info(` ${this.configuration.mainData.components[i].name} has a README file, include it`);
                        let readmeFile = $markdownengine.readNeighbourReadmeFile(this.configuration.mainData.components[i].file);
                        this.configuration.mainData.components[i].readme = marked(readmeFile);
                        this.configuration.addPage({
                            path: 'components',
                            name: this.configuration.mainData.components[i].name,
                            id: this.configuration.mainData.components[i].id,
                            context: 'component',
                            component: this.configuration.mainData.components[i],
                            depth: 1,
                            pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                        });
                        if (this.configuration.mainData.components[i].templateUrl.length > 0) {
                            logger.info(` ${this.configuration.mainData.components[i].name} has a templateUrl, include it`);
                            this.handleTemplateurl(this.configuration.mainData.components[i]).then(() => {
                                i++;
                                loop();
                            }, (e) => {
                                logger.error(e);
                            });
                        } else {
                            i++;
                            loop();
                        }
                    } else {
                        this.configuration.addPage({
                            path: 'components',
                            name: this.configuration.mainData.components[i].name,
                            id: this.configuration.mainData.components[i].id,
                            context: 'component',
                            component: this.configuration.mainData.components[i],
                            depth: 1,
                            pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                        });
                        if (this.configuration.mainData.components[i].templateUrl.length > 0) {
                            logger.info(` ${this.configuration.mainData.components[i].name} has a templateUrl, include it`);
                            this.handleTemplateurl(this.configuration.mainData.components[i]).then(() => {
                                i++;
                                loop();
                            }, (e) => {
                                logger.error(e);
                            });
                        } else {
                            i++;
                            loop();
                        }
                    }
                } else {
                    mainResolve();
                }
            };
            loop();
        });
    }

    public prepareDirectives(someDirectives?) {
        logger.info('Prepare directives');

        this.configuration.mainData.directives = (someDirectives) ? someDirectives : this.dependenciesEngine.getDirectives();

        return new Promise((resolve, reject) => {
            let i = 0;
            let len = this.configuration.mainData.directives.length;
            let loop = () => {
                if (i < len) {
                    if ($markdownengine.hasNeighbourReadmeFile(this.configuration.mainData.directives[i].file)) {
                        logger.info(` ${this.configuration.mainData.directives[i].name} has a README file, include it`);
                        let readme = $markdownengine.readNeighbourReadmeFile(this.configuration.mainData.directives[i].file);
                        this.configuration.mainData.directives[i].readme = marked(readme);
                    }
                    this.configuration.addPage({
                        path: 'directives',
                        name: this.configuration.mainData.directives[i].name,
                        id: this.configuration.mainData.directives[i].id,
                        context: 'directive',
                        directive: this.configuration.mainData.directives[i],
                        depth: 1,
                        pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                    });
                    i++;
                    loop();
                } else {
                    resolve();
                }
            };
            loop();
        });
    }

    public prepareInjectables(someInjectables?): Promise<void> {
        logger.info('Prepare injectables');

        this.configuration.mainData.injectables = (someInjectables) ? someInjectables : this.dependenciesEngine.getInjectables();

        return new Promise((resolve, reject) => {
            let i = 0;
            let len = this.configuration.mainData.injectables.length;
            let loop = () => {
                if (i < len) {
                    if ($markdownengine.hasNeighbourReadmeFile(this.configuration.mainData.injectables[i].file)) {
                        logger.info(` ${this.configuration.mainData.injectables[i].name} has a README file, include it`);
                        let readme = $markdownengine.readNeighbourReadmeFile(this.configuration.mainData.injectables[i].file);
                        this.configuration.mainData.injectables[i].readme = marked(readme);
                    }
                    this.configuration.addPage({
                        path: 'injectables',
                        name: this.configuration.mainData.injectables[i].name,
                        id: this.configuration.mainData.injectables[i].id,
                        context: 'injectable',
                        injectable: this.configuration.mainData.injectables[i],
                        depth: 1,
                        pageType: COMPODOC_DEFAULTS.PAGE_TYPES.INTERNAL
                    });
                    i++;
                    loop();
                } else {
                    resolve();
                }
            };
            loop();
        });
    }

    public prepareRoutes(): Promise<void> {
        logger.info('Process routes');
        this.configuration.mainData.routes = this.dependenciesEngine.getRoutes();

        return new Promise((resolve, reject) => {

            this.configuration.addPage({
                name: 'routes',
                id: 'routes',
                context: 'routes',
                depth: 0,
                pageType: COMPODOC_DEFAULTS.PAGE_TYPES.ROOT
            });

            if (this.configuration.mainData.exportFormat === COMPODOC_DEFAULTS.exportFormat) {
                this.routerParser.generateRoutesIndex(this.configuration.mainData.output, this.configuration.mainData.routes).then(() => {
                    logger.info(' Routes index generated');
                    resolve();
                }, (e) => {
                    logger.error(e);
                    reject();
                });
            } else {
                resolve();
            }

        });
    }

    public prepareCoverage() {
        logger.info('Process documentation coverage report');

        return this.coverageEngine.calculate(generationPromiseResolve, generationPromiseReject);
    }

    private processPage(page): Promise<void> {
        logger.info('Process page', page.name);

        let htmlData = this.htmlEngine.render(this.configuration.mainData, page);
        let finalPath = this.configuration.mainData.output;

        if (this.configuration.mainData.output.lastIndexOf('/') === -1) {
            finalPath += '/';
        }
        if (page.path) {
            finalPath += page.path + '/';
        }

        if (page.filename) {
            finalPath += page.filename + '.html';
        } else {
            finalPath += page.name + '.html';
        }

        this.searchEngine.indexPage({
            infos: page,
            rawData: htmlData,
            url: finalPath
        });

        return this.fileEngine.write(finalPath, htmlData).catch(err => {
            logger.error('Error during ' + page.name + ' page generation');
            return Promise.reject('');
        });
    }

    public processPages() {
        logger.info('Process pages');
        let pages = this.configuration.pages;
        Promise.all(pages.map((page) => this.processPage(page)))
            .then(() => {
                this.searchEngine.generateSearchIndexJson(this.configuration.mainData.output).then(() => {
                    if (this.configuration.mainData.additionalPages.length > 0) {
                        this.processAdditionalPages();
                    } else {
                        if (this.configuration.mainData.assetsFolder !== '') {
                            this.processAssetsFolder();
                        }
                        this.processResources();
                    }
                }, (e) => {
                    logger.error(e);
                });
            })
            .catch((e) => {
                logger.error(e);
            });
    }

    public processAdditionalPages() {
        logger.info('Process additional pages');
        let pages = this.configuration.mainData.additionalPages;
        Promise.all(pages.map((page, i) => this.processPage(page)))
            .then(() => {
                this.searchEngine.generateSearchIndexJson(this.configuration.mainData.output).then(() => {
                    if (this.configuration.mainData.assetsFolder !== '') {
                        this.processAssetsFolder();
                    }
                    this.processResources();
                });
            })
            .catch((e) => {
                logger.error(e);
                return Promise.reject(e);
            });
    }

    public processAssetsFolder(): void {
        logger.info('Copy assets folder');

        if (!this.fileEngine.existsSync(this.configuration.mainData.assetsFolder)) {
            logger.error(`Provided assets folder ${this.configuration.mainData.assetsFolder} did not exist`);
        } else {
            fs.copy(
                path.resolve(this.configuration.mainData.assetsFolder),
                path.resolve(this.configuration.mainData.output + path.sep + this.configuration.mainData.assetsFolder), (err) => {
                    if (err) {
                        logger.error('Error during resources copy ', err);
                    }
                });
        }
    }

    public processResources() {
        logger.info('Copy main resources');

        const onComplete = () => {
            let finalTime = (new Date() - startTime) / 1000;
            logger.info('Documentation generated in ' + this.configuration.mainData.output +
                ' in ' + finalTime +
                ' seconds using ' + this.configuration.mainData.theme + ' theme');
            if (this.configuration.mainData.serve) {
                logger.info(`Serving documentation from ${this.configuration.mainData.output} at http://127.0.0.1:${this.configuration.mainData.port}`);
                this.runWebServer(this.configuration.mainData.output);
            } else {
                generationPromiseResolve();
                this.endCallback();
            }
        };

        let finalOutput = this.configuration.mainData.output;

        let testOutputDir = this.configuration.mainData.output.match(process.cwd());
        if (!testOutputDir) {
            finalOutput = this.configuration.mainData.output.replace(process.cwd(), '');
        }

        fs.copy(path.resolve(__dirname + '/../src/resources/'), path.resolve(finalOutput), (err) => {
            if (err) {
                logger.error('Error during resources copy ', err);
            } else {
                if (this.configuration.mainData.extTheme) {
                    fs.copy(path.resolve(process.cwd() + path.sep + this.configuration.mainData.extTheme),
                        path.resolve(finalOutput + '/styles/'), function (err1) {
                            if (err1) {
                                logger.error('Error during external styling theme copy ', err1);
                            } else {
                                logger.info('External styling theme copy succeeded');
                                onComplete();
                            }
                        });
                } else {
                    if (this.configuration.mainData.customFavicon !== '') {
                        logger.info(`Custom favicon supplied`);
                        fs.copy(path.resolve(process.cwd() + path.sep + this.configuration.mainData.customFavicon), path.resolve(finalOutput + '/images/favicon.ico'), (err) => {
                            if (err) {
                                logger.error('Error during resources copy ', err);
                            } else {
                                onComplete();
                            }
                        });
                    } else {
                        onComplete();
                    }
                }
            }
        });
    }

    public processGraphs() {

        if (this.configuration.mainData.disableGraph) {
            logger.info('Graph generation disabled');
            this.processPages();
        } else {
            logger.info('Process main graph');
            let modules = this.configuration.mainData.modules;
            let i = 0;
            let len = modules.length;
            let loop = () => {
                if (i <= len - 1) {
                    logger.info('Process module graph', modules[i].name);
                    let finalPath = this.configuration.mainData.output;
                    if (this.configuration.mainData.output.lastIndexOf('/') === -1) {
                        finalPath += '/';
                    }
                    finalPath += 'modules/' + modules[i].name;
                    let _rawModule = this.dependenciesEngine.getRawModule(modules[i].name);
                    if (_rawModule.declarations.length > 0 ||
                        _rawModule.bootstrap.length > 0 ||
                        _rawModule.imports.length > 0 ||
                        _rawModule.exports.length > 0 ||
                        _rawModule.providers.length > 0) {
                        this.ngdEngine.renderGraph(modules[i].file, finalPath, 'f', modules[i].name).then(() => {
                            this.ngdEngine.readGraph(path.resolve(finalPath + path.sep + 'dependencies.svg'), modules[i].name)
                                .then((data) => {
                                    modules[i].graph = data as string;
                                    i++;
                                    loop();
                                }, (err) => {
                                    logger.error('Error during graph read: ', err);
                                });
                        }, (errorMessage) => {
                            logger.error(errorMessage);
                        });
                    } else {
                        i++;
                        loop();
                    }
                } else {
                    this.processPages();
                }
            };
            let finalMainGraphPath = this.configuration.mainData.output;
            if (finalMainGraphPath.lastIndexOf('/') === -1) {
                finalMainGraphPath += '/';
            }
            finalMainGraphPath += 'graph';
            this.ngdEngine.init(path.resolve(finalMainGraphPath));

            this.ngdEngine.renderGraph(this.configuration.mainData.tsconfig, path.resolve(finalMainGraphPath), 'p').then(() => {
                this.ngdEngine.readGraph(path.resolve(finalMainGraphPath + path.sep + 'dependencies.svg'), 'Main graph').then((data) => {
                    this.configuration.mainData.mainGraph = data as string;
                    loop();
                }, (err) => {
                    logger.error('Error during main graph reading : ', err);
                    this.configuration.mainData.disableMainGraph = true;
                    loop();
                });
            }, (err) => {
                logger.error('Ooops error during main graph generation, moving on next part with main graph disabled : ', err);
                this.configuration.mainData.disableMainGraph = true;
                loop();
            });
        }
    }

    public runWebServer(folder) {
        if (!this.isWatching) {
            LiveServer.start({
                root: folder,
                open: this.configuration.mainData.open,
                quiet: true,
                logLevel: 0,
                wait: 1000,
                port: this.configuration.mainData.port
            });
        }
        if (this.configuration.mainData.watch && !this.isWatching) {
            if (typeof this.files === 'undefined') {
                logger.error('No sources files available, please use -p flag');
                generationPromiseReject();
                process.exit(1);
            } else {
                this.runWatch();
            }
        } else if (this.configuration.mainData.watch && this.isWatching) {
            let srcFolder = findMainSourceFolder(this.files);
            logger.info(`Already watching sources in ${srcFolder} folder`);
        }
    }

    public runWatch() {
        let sources = [findMainSourceFolder(this.files)];
        let watcherReady = false;

        this.isWatching = true;

        logger.info(`Watching sources in ${findMainSourceFolder(this.files)} folder`);

        if ($markdownengine.hasRootMarkdowns()) {
            sources = sources.concat($markdownengine.listRootMarkdowns());
        }

        if (this.configuration.mainData.includes !== '') {
            sources = sources.concat(this.configuration.mainData.includes);
        }

        // Check all elements of sources list exist
        sources = cleanSourcesForWatch(sources);

        let watcher = chokidar.watch(sources, {
            awaitWriteFinish: true,
            ignoreInitial: true,
            ignored: /(spec|\.d)\.ts/
        });
        let timerAddAndRemoveRef;
        let timerChangeRef;
        let waiterAddAndRemove = () => {
            clearTimeout(timerAddAndRemoveRef);
            timerAddAndRemoveRef = setTimeout(runnerAddAndRemove, 1000);
        };
        let runnerAddAndRemove = () => {
            startTime = new Date();
            this.generate();
        };
        let waiterChange = () => {
            clearTimeout(timerChangeRef);
            timerChangeRef = setTimeout(runnerChange, 1000);
        };
        let runnerChange = () => {
            startTime = new Date();
            this.setUpdatedFiles(this.watchChangedFiles);
            if (this.hasWatchedFilesTSFiles()) {
                this.getMicroDependenciesData();
            } else if (this.hasWatchedFilesRootMarkdownFiles()) {
                this.rebuildRootMarkdowns();
            } else {
                this.rebuildExternalDocumentation();
            }
        };

        watcher
            .on('ready', () => {
                if (!watcherReady) {
                    watcherReady = true;
                    watcher
                        .on('add', (file) => {
                            logger.debug(`File ${file} has been added`);
                            // Test extension, if ts
                            // rescan everything
                            if (path.extname(file) === '.ts') {
                                waiterAddAndRemove();
                            }
                        })
                        .on('change', (file) => {
                            logger.debug(`File ${file} has been changed`);
                            // Test extension, if ts
                            // rescan only file
                            if (path.extname(file) === '.ts' || path.extname(file) === '.md' || path.extname(file) === '.json') {
                                this.watchChangedFiles.push(path.join(process.cwd() + path.sep + file));
                                waiterChange();
                            }
                        })
                        .on('unlink', (file) => {
                            logger.debug(`File ${file} has been removed`);
                            // Test extension, if ts
                            // rescan everything
                            if (path.extname(file) === '.ts') {
                                waiterAddAndRemove();
                            }
                        });
                }
            });
    }

    /**
     * Return the application / root component instance.
     */
    get application(): Application {
        return this;
    }


    get isCLI(): boolean {
        return false;
    }
}
