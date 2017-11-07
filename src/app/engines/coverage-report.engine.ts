import * as path from 'path';
import * as fs from 'fs-extra';
import * as _ from 'lodash';
import * as ts from 'typescript';

import { logger } from '../../logger';
import { DependenciesEngine } from './dependencies.engine';
import { ConfigurationInterface } from '../interfaces/configuration.interface';
import { FileEngine } from './file.engine';
import { HtmlEngine } from './html.engine';
import { COMPODOC_DEFAULTS } from '../../utils/defaults';

import { ExportData } from '../interfaces/export-data.interface';

export class CoverageEngine {
    constructor(
        private configuration: ConfigurationInterface,
        private dependenciesEngine: DependenciesEngine,
        private fileEngine: FileEngine = new FileEngine(),
        private htmlEngine: HtmlEngine) {
    }

    calculateTable() {
        let table = [
            {
                text: 'Documentation coverage',
                tocItem: true,
                style: 'header',
                pageBreak: 'before'
            }, {
                text: `Global coverage : ${this.configuration.mainData.coverageData.count}%`,
                margin: [0, 25]
            }, {
                table: {
                    headerRows: 1,
                    widths: ['*', 'auto', '*', 'auto'],
                    body: [
                        [{ text: 'File', bold: true }, { text: 'Type', bold: true }, { text: 'Identifier', bold: true }, { text: 'Statements', bold: true }]
                    ]
                }
            }];

        let tableBody = table[2].table.body;

        _.forEach(this.configuration.mainData.coverageData.files, (file) => {
            tableBody.push([file.filePath, file.type, file.name, `${file.coveragePercent}% - (${file.coverageCount})`])
        })

        return table;
    }

    calculate(generationPromiseResolve, generationPromiseReject) {
        return new Promise((resolve, reject) => {
            /*
             * loop with components, directives, classes, injectables, interfaces, pipes
             */
            let files = [];
            let totalProjectStatementDocumented = 0;
            let getStatus = function(percent) {
                let status;
                if (percent <= 25) {
                    status = 'low';
                } else if (percent > 25 && percent <= 50) {
                    status = 'medium';
                } else if (percent > 50 && percent <= 75) {
                    status = 'good';
                } else {
                    status = 'very-good';
                }
                return status;
            };
            let processComponentsAndDirectives = (list) => {
                _.forEach(list, (element: any) => {
                    if (!element.propertiesClass ||
                        !element.methodsClass ||
                        !element.hostBindings ||
                        !element.hostListeners ||
                        !element.inputsClass ||
                        !element.outputsClass) {
                        return;
                    }
                    let cl: any = {
                        filePath: element.file,
                        type: element.type,
                        linktype: element.type,
                        name: element.name
                    };
                    let totalStatementDocumented = 0;
                    let totalStatements =
                        element.propertiesClass.length +
                        element.methodsClass.length +
                        element.inputsClass.length +
                        element.hostBindings.length +
                        element.hostListeners.length +
                        element.outputsClass.length + 1; // +1 for element decorator comment
                    if (element.constructorObj) {
                        totalStatements += 1;
                        if (element.constructorObj && element.constructorObj.description && element.constructorObj.description !== '') {
                            totalStatementDocumented += 1;
                        }
                    }
                    if (element.description && element.description !== '') {
                        totalStatementDocumented += 1;
                    }

                    _.forEach(element.propertiesClass, (property: any) => {
                        if (property.modifierKind === ts.SyntaxKind.PrivateKeyword) { // Doesn't handle private for coverage
                            totalStatements -= 1;
                        }
                        if (property.description && property.description !== '' && property.modifierKind !== ts.SyntaxKind.PrivateKeyword) {
                            totalStatementDocumented += 1;
                        }
                    });
                    _.forEach(element.methodsClass, (method: any) => {
                        if (method.modifierKind === ts.SyntaxKind.PrivateKeyword) { // Doesn't handle private for coverage
                            totalStatements -= 1;
                        }
                        if (method.description && method.description !== '' && method.modifierKind !== ts.SyntaxKind.PrivateKeyword) {
                            totalStatementDocumented += 1;
                        }
                    });
                    _.forEach(element.hostBindings, (property: any) => {
                        if (property.modifierKind === ts.SyntaxKind.PrivateKeyword) { // Doesn't handle private for coverage
                            totalStatements -= 1;
                        }
                        if (property.description && property.description !== '' && property.modifierKind !== ts.SyntaxKind.PrivateKeyword) {
                            totalStatementDocumented += 1;
                        }
                    });
                    _.forEach(element.hostListeners, (method: any) => {
                        if (method.modifierKind === ts.SyntaxKind.PrivateKeyword) { // Doesn't handle private for coverage
                            totalStatements -= 1;
                        }
                        if (method.description && method.description !== '' && method.modifierKind !== ts.SyntaxKind.PrivateKeyword) {
                            totalStatementDocumented += 1;
                        }
                    });
                    _.forEach(element.inputsClass, (input: any) => {
                        if (input.modifierKind === ts.SyntaxKind.PrivateKeyword) { // Doesn't handle private for coverage
                            totalStatements -= 1;
                        }
                        if (input.description && input.description !== '' && input.modifierKind !== ts.SyntaxKind.PrivateKeyword) {
                            totalStatementDocumented += 1;
                        }
                    });
                    _.forEach(element.outputsClass, (output: any) => {
                        if (output.modifierKind === ts.SyntaxKind.PrivateKeyword) { // Doesn't handle private for coverage
                            totalStatements -= 1;
                        }
                        if (output.description && output.description !== '' && output.modifierKind !== ts.SyntaxKind.PrivateKeyword) {
                            totalStatementDocumented += 1;
                        }
                    });

                    cl.coveragePercent = Math.floor((totalStatementDocumented / totalStatements) * 100);
                    if (totalStatements === 0) {
                        cl.coveragePercent = 0;
                    }
                    cl.coverageCount = totalStatementDocumented + '/' + totalStatements;
                    cl.status = getStatus(cl.coveragePercent);
                    totalProjectStatementDocumented += cl.coveragePercent;
                    files.push(cl);
                });
            };
            let processCoveragePerFile = () => {
                logger.info('Process documentation coverage per file');
                logger.info('-------------------');

                let overFiles = files.filter((f) => {
                    let overTest = f.coveragePercent >= this.configuration.mainData.coverageMinimumPerFile;
                    if (overTest) {
                        logger.info(`${f.coveragePercent} % for file ${f.filePath} - over minimum per file`);
                    }
                    return overTest;
                });
                let underFiles = files.filter((f) => {
                    let underTest = f.coveragePercent < this.configuration.mainData.coverageMinimumPerFile;
                    if (underTest) {
                        logger.error(`${f.coveragePercent} % for file ${f.filePath} - under minimum per file`);
                    }
                    return underTest;
                });

                logger.info('-------------------');
                return {
                    overFiles: overFiles,
                    underFiles: underFiles
                };
            };

            processComponentsAndDirectives(this.configuration.mainData.components);
            processComponentsAndDirectives(this.configuration.mainData.directives);

            _.forEach(this.configuration.mainData.classes, (classe: any) => {
                if (!classe.properties ||
                    !classe.methods) {
                    return;
                }
                let cl: any = {
                    filePath: classe.file,
                    type: 'class',
                    linktype: 'classe',
                    name: classe.name
                };
                let totalStatementDocumented = 0;
                let totalStatements = classe.properties.length + classe.methods.length + 1; // +1 for class itself
                if (classe.constructorObj) {
                    totalStatements += 1;
                    if (classe.constructorObj && classe.constructorObj.description && classe.constructorObj.description !== '') {
                        totalStatementDocumented += 1;
                    }
                }
                if (classe.description && classe.description !== '') {
                    totalStatementDocumented += 1;
                }

                _.forEach(classe.properties, (property: any) => {
                    if (property.modifierKind === ts.SyntaxKind.PrivateKeyword) { // Doesn't handle private for coverage
                        totalStatements -= 1;
                    }
                    if (property.description && property.description !== '' && property.modifierKind !== ts.SyntaxKind.PrivateKeyword) {
                        totalStatementDocumented += 1;
                    }
                });
                _.forEach(classe.methods, (method: any) => {
                    if (method.modifierKind === ts.SyntaxKind.PrivateKeyword) { // Doesn't handle private for coverage
                        totalStatements -= 1;
                    }
                    if (method.description && method.description !== '' && method.modifierKind !== ts.SyntaxKind.PrivateKeyword) {
                        totalStatementDocumented += 1;
                    }
                });

                cl.coveragePercent = Math.floor((totalStatementDocumented / totalStatements) * 100);
                if (totalStatements === 0) {
                    cl.coveragePercent = 0;
                }
                cl.coverageCount = totalStatementDocumented + '/' + totalStatements;
                cl.status = getStatus(cl.coveragePercent);
                totalProjectStatementDocumented += cl.coveragePercent;
                files.push(cl);
            });
            _.forEach(this.configuration.mainData.injectables, (injectable: any) => {
                if (!injectable.properties ||
                    !injectable.methods) {
                    return;
                }
                let cl: any = {
                    filePath: injectable.file,
                    type: injectable.type,
                    linktype: injectable.type,
                    name: injectable.name
                };
                let totalStatementDocumented = 0;
                let totalStatements = injectable.properties.length + injectable.methods.length + 1; // +1 for injectable itself
                if (injectable.constructorObj) {
                    totalStatements += 1;
                    if (injectable.constructorObj &&
                        injectable.constructorObj.description &&
                        injectable.constructorObj.description !== '') {
                        totalStatementDocumented += 1;
                    }
                }
                if (injectable.description && injectable.description !== '') {
                    totalStatementDocumented += 1;
                }

                _.forEach(injectable.properties, (property: any) => {
                    if (property.modifierKind === ts.SyntaxKind.PrivateKeyword) { // Doesn't handle private for coverage
                        totalStatements -= 1;
                    }
                    if (property.description && property.description !== '' && property.modifierKind !== ts.SyntaxKind.PrivateKeyword) {
                        totalStatementDocumented += 1;
                    }
                });
                _.forEach(injectable.methods, (method: any) => {
                    if (method.modifierKind === ts.SyntaxKind.PrivateKeyword) { // Doesn't handle private for coverage
                        totalStatements -= 1;
                    }
                    if (method.description && method.description !== '' && method.modifierKind !== ts.SyntaxKind.PrivateKeyword) {
                        totalStatementDocumented += 1;
                    }
                });

                cl.coveragePercent = Math.floor((totalStatementDocumented / totalStatements) * 100);
                if (totalStatements === 0) {
                    cl.coveragePercent = 0;
                }
                cl.coverageCount = totalStatementDocumented + '/' + totalStatements;
                cl.status = getStatus(cl.coveragePercent);
                totalProjectStatementDocumented += cl.coveragePercent;
                files.push(cl);
            });
            _.forEach(this.configuration.mainData.interfaces, (inter: any) => {
                if (!inter.properties ||
                    !inter.methods) {
                    return;
                }
                let cl: any = {
                    filePath: inter.file,
                    type: inter.type,
                    linktype: inter.type,
                    name: inter.name
                };
                let totalStatementDocumented = 0;
                let totalStatements = inter.properties.length + inter.methods.length + 1; // +1 for interface itself
                if (inter.constructorObj) {
                    totalStatements += 1;
                    if (inter.constructorObj && inter.constructorObj.description && inter.constructorObj.description !== '') {
                        totalStatementDocumented += 1;
                    }
                }
                if (inter.description && inter.description !== '') {
                    totalStatementDocumented += 1;
                }

                _.forEach(inter.properties, (property: any) => {
                    if (property.modifierKind === ts.SyntaxKind.PrivateKeyword) { // Doesn't handle private for coverage
                        totalStatements -= 1;
                    }
                    if (property.description && property.description !== '' && property.modifierKind !== ts.SyntaxKind.PrivateKeyword) {
                        totalStatementDocumented += 1;
                    }
                });
                _.forEach(inter.methods, (method: any) => {
                    if (method.modifierKind === ts.SyntaxKind.PrivateKeyword) { // Doesn't handle private for coverage
                        totalStatements -= 1;
                    }
                    if (method.description && method.description !== '' && method.modifierKind !== ts.SyntaxKind.PrivateKeyword) {
                        totalStatementDocumented += 1;
                    }
                });

                cl.coveragePercent = Math.floor((totalStatementDocumented / totalStatements) * 100);
                if (totalStatements === 0) {
                    cl.coveragePercent = 0;
                }
                cl.coverageCount = totalStatementDocumented + '/' + totalStatements;
                cl.status = getStatus(cl.coveragePercent);
                totalProjectStatementDocumented += cl.coveragePercent;
                files.push(cl);
            });
            _.forEach(this.configuration.mainData.pipes, (pipe: any) => {
                let cl: any = {
                    filePath: pipe.file,
                    type: pipe.type,
                    linktype: pipe.type,
                    name: pipe.name
                };
                let totalStatementDocumented = 0;
                let totalStatements = 1;
                if (pipe.description && pipe.description !== '') {
                    totalStatementDocumented += 1;
                }

                cl.coveragePercent = Math.floor((totalStatementDocumented / totalStatements) * 100);
                cl.coverageCount = totalStatementDocumented + '/' + totalStatements;
                cl.status = getStatus(cl.coveragePercent);
                totalProjectStatementDocumented += cl.coveragePercent;
                files.push(cl);
            });
            files = _.sortBy(files, ['filePath']);
            let coverageData = {
                count: (files.length > 0) ? Math.floor(totalProjectStatementDocumented / files.length) : 0,
                status: '',
                files
            };
            coverageData.status = getStatus(coverageData.count);
            this.configuration.addPage({
                name: 'coverage',
                id: 'coverage',
                context: 'coverage',
                files: files,
                data: coverageData,
                depth: 0,
                pageType: COMPODOC_DEFAULTS.PAGE_TYPES.ROOT
            });
            coverageData.files = files;
            this.configuration.mainData.coverageData = coverageData;
            if (this.configuration.mainData.exportFormat === COMPODOC_DEFAULTS.exportFormat) {
                this.htmlEngine.generateCoverageBadge(this.configuration.mainData.output, coverageData);
            }
            files = _.sortBy(files, ['coveragePercent']);
            let coverageTestPerFileResults;
            if (this.configuration.mainData.coverageTest && !this.configuration.mainData.coverageTestPerFile) {
                // Global coverage test and not per file
                if (coverageData.count >= this.configuration.mainData.coverageTestThreshold) {
                    logger.info(`Documentation coverage (${coverageData.count}%) is over threshold`);
                    generationPromiseResolve();
                    process.exit(0);
                } else {
                    logger.error(`Documentation coverage (${coverageData.count}%) is not over threshold`);
                    generationPromiseReject();
                    process.exit(1);
                }
            } else if (!this.configuration.mainData.coverageTest && this.configuration.mainData.coverageTestPerFile) {
                coverageTestPerFileResults = processCoveragePerFile();
                // Per file coverage test and not global
                if (coverageTestPerFileResults.underFiles.length > 0) {
                    logger.error('Documentation coverage per file is not achieved');
                    generationPromiseReject();
                    process.exit(1);
                } else {
                    logger.info('Documentation coverage per file is achieved');
                    generationPromiseResolve();
                    process.exit(0);
                }
            } else if (this.configuration.mainData.coverageTest && this.configuration.mainData.coverageTestPerFile) {
                // Per file coverage test and global
                coverageTestPerFileResults = processCoveragePerFile();
                if (coverageData.count >= this.configuration.mainData.coverageTestThreshold &&
                    coverageTestPerFileResults.underFiles.length === 0) {
                    logger.info(`Documentation coverage (${coverageData.count}%) is over threshold`);
                    logger.info('Documentation coverage per file is achieved');
                    generationPromiseResolve();
                    process.exit(0);
                } else if (coverageData.count >= this.configuration.mainData.coverageTestThreshold &&
                    coverageTestPerFileResults.underFiles.length > 0) {
                    logger.info(`Documentation coverage (${coverageData.count}%) is over threshold`);
                    logger.error('Documentation coverage per file is not achieved');
                    generationPromiseReject();
                    process.exit(1);
                } else if (coverageData.count < this.configuration.mainData.coverageTestThreshold &&
                    coverageTestPerFileResults.underFiles.length > 0) {
                    logger.error(`Documentation coverage (${coverageData.count}%) is not over threshold`);
                    logger.error('Documentation coverage per file is not achieved');
                    generationPromiseReject();
                    process.exit(1);
                } else {
                    logger.error(`Documentation coverage (${coverageData.count}%) is not over threshold`);
                    logger.info('Documentation coverage per file is achieved');
                    generationPromiseReject();
                    process.exit(1);
                }
            } else {
                resolve();
            }
        });
    }

}
