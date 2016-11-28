import * as esprima from 'esprima';
import * as escodegen from 'escodegen';
import * as ESTree from 'estree';

import { Chance } from 'chance';

import { ICustomNode } from './interfaces/custom-nodes/ICustomNode';
import { IGeneratorOutput } from './interfaces/IGeneratorOutput';
import { IObfuscationResult } from './interfaces/IObfuscationResult';
import { IOptions } from './interfaces/IOptions';
import { IStorage } from './interfaces/IStorage';

import { CustomNodesStorage } from './storages/custom-nodes/CustomNodesStorage';
import { NodeUtils } from './node/NodeUtils';
import { ObfuscationEventEmitter } from './event-emitters/ObfuscationEventEmitter';
import { ObfuscationResult } from './ObfuscationResult';
import { Obfuscator } from './Obfuscator';
import { SourceMapCorrector } from './SourceMapCorrector';
import { StackTraceAnalyzer } from './stack-trace-analyzer/StackTraceAnalyzer';
import { Utils } from './Utils';

export class JavaScriptObfuscatorInternal {
    /**
     * @type {GenerateOptions}
     */
    private static readonly escodegenParams: escodegen.GenerateOptions = {
        verbatim: 'x-verbatim-property',
        sourceMapWithCode: true
    };

    /**
     * @type {esprima.Options}
     */
    private static readonly esprimaParams: esprima.Options = {
        loc: true
    };

    /**
     * @type {IOptions}
     */
    private readonly options: IOptions;

    /**
     * @param options
     */
    constructor (options: IOptions) {
        this.options = options;
    }

    /**
     * @param sourceCode
     * @param astTree
     */
    private generateCode (sourceCode: string, astTree: ESTree.Program): IGeneratorOutput {
        const escodegenParams: escodegen.GenerateOptions = Object.assign(
            {},
            JavaScriptObfuscatorInternal.escodegenParams
        );

        if (this.options.sourceMap) {
            escodegenParams.sourceMap = 'sourceMap';
            escodegenParams.sourceContent = sourceCode;
        }

        escodegenParams.format = {
            compact: this.options.compact
        };

        const generatorOutput: IGeneratorOutput = escodegen.generate(astTree, escodegenParams);

        generatorOutput.map = generatorOutput.map ? generatorOutput.map.toString() : '';

        return generatorOutput;
    }

    /**
     * @param generatorOutput
     * @returns {IObfuscationResult}
     */
    public getObfuscationResult (generatorOutput: IGeneratorOutput): IObfuscationResult {
        return new SourceMapCorrector(
            new ObfuscationResult(
                generatorOutput.code,
                generatorOutput.map
            ),
            this.options.sourceMapBaseUrl + this.options.sourceMapFileName,
            this.options.sourceMapMode
        ).correct();
    }

    /**
     * @param sourceCode
     * @returns {IObfuscationResult}
     */
    public obfuscate (sourceCode: string): IObfuscationResult {
        if (this.options.seed !== 0) {
            Utils.setRandomGenerator(new Chance(this.options.seed));
        }

        // parse AST tree
        const astTree: ESTree.Program = esprima.parse(sourceCode, JavaScriptObfuscatorInternal.esprimaParams);

        NodeUtils.parentize(astTree);

        // obfuscate AST tree
        const customNodesStorage: IStorage<ICustomNode> = new CustomNodesStorage(this.options);

        customNodesStorage.initialize(
            new StackTraceAnalyzer().analyze(astTree.body)
        );

        const obfuscatedAstTree: ESTree.Program = new Obfuscator(
            new ObfuscationEventEmitter(),
            this.options
        ).obfuscateAstTree(astTree, customNodesStorage);

        // generate code
        const generatorOutput: IGeneratorOutput = this.generateCode(sourceCode, obfuscatedAstTree);

        return this.getObfuscationResult(generatorOutput);
    }
}
