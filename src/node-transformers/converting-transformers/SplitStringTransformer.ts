import { inject, injectable, } from 'inversify';
import { ServiceIdentifiers } from '../../container/ServiceIdentifiers';

import * as estraverse from '@javascript-obfuscator/estraverse';
import * as ESTree from 'estree';
import * as stringz from 'stringz';

import { IOptions } from '../../interfaces/options/IOptions';
import { IRandomGenerator } from '../../interfaces/utils/IRandomGenerator';
import { IVisitor } from '../../interfaces/node-transformers/IVisitor';

import { NodeTransformer } from '../../enums/node-transformers/NodeTransformer';
import { NodeTransformationStage } from '../../enums/node-transformers/NodeTransformationStage';

import { AbstractNodeTransformer } from '../AbstractNodeTransformer';
import { NodeFactory } from '../../node/NodeFactory';
import { NodeGuards } from '../../node/NodeGuards';
import { NodeLiteralUtils } from '../../node/NodeLiteralUtils';
import { NodeUtils } from '../../node/NodeUtils';

/**
 * Splits strings into parts
 */
@injectable()
export class SplitStringTransformer extends AbstractNodeTransformer {
    private static readonly maxStringLengthForSecondPass: number = 30000;

    /**
     * @type {number}
     */
    private static readonly firstPassChunkLength: number = 1000;

    /**
     * @type {NodeTransformer[]}
     */
    public override runAfter: NodeTransformer[] = [
        NodeTransformer.ObjectExpressionKeysTransformer,
        NodeTransformer.TemplateLiteralTransformer
    ];

    /**
     * @param {IRandomGenerator} randomGenerator
     * @param {IOptions} options
     */
    public constructor (
        @inject(ServiceIdentifiers.IRandomGenerator) randomGenerator: IRandomGenerator,
        @inject(ServiceIdentifiers.IOptions) options: IOptions
    ) {
        super(randomGenerator, options);
    }

    /**
     * @param {string} string
     * @param {number} stringLength
     * @param {number} chunkSize
     * @returns {string[]}
     */
    private static chunkString (
        string: string,
        stringLength: number,
        chunkSize: number
    ): string[] {
        const chunksCount: number = Math.ceil(stringLength / chunkSize);
        const chunks: string[] = [];

        let nextChunkStartIndex: number = 0;

        for (
            let chunkIndex: number = 0;
            chunkIndex < chunksCount;
            ++chunkIndex, nextChunkStartIndex += chunkSize
        ) {
            // eslint-disable-next-line unicorn/prefer-string-slice
            chunks[chunkIndex] = stringz.substr(string, nextChunkStartIndex, chunkSize);
        }

        return chunks;
    }

    /**
     * @param {NodeTransformationStage} nodeTransformationStage
     * @returns {IVisitor | null}
     */
    public getVisitor (nodeTransformationStage: NodeTransformationStage): IVisitor | null {
        if (!this.options.splitStrings) {
            return null;
        }

        switch (nodeTransformationStage) {
            case NodeTransformationStage.Converting:
                return {
                    leave: (node: ESTree.Node, parentNode: ESTree.Node | null): ESTree.Node | undefined => {
                        if (parentNode && NodeGuards.isLiteralNode(node)) {
                            return this.transformNode(node, parentNode);
                        }
                    }
                };

            default:
                return null;
        }
    }

    /**
     * Needs to split string on chunks of length `splitStringsChunkLength` in two pass, because of
     * `Maximum call stack size exceeded` error in `esrecurse` package
     *
     * @param {Literal} literalNode
     * @param {Node} parentNode
     * @returns {Node}
     */
    public transformNode (literalNode: ESTree.Literal, parentNode: ESTree.Node): ESTree.Node {
        if (NodeLiteralUtils.isProhibitedLiteralNode(literalNode, parentNode)) {
            return literalNode;
        }

        // pass #1: split string on a large chunks with length of `firstPassChunkLength`
        const [firstPassChunksNode, stringChunks]: [ESTree.Node, string[]] = this.transformLiteralNodeByChunkLength(
            literalNode,
            SplitStringTransformer.firstPassChunkLength
        );

        const stringChunksCount: number = stringChunks.length;
        const isLargeString: boolean = SplitStringTransformer.maxStringLengthForSecondPass
            / SplitStringTransformer.firstPassChunkLength
            <= stringChunksCount;
        const minSecondPathChunkLength = isLargeString
            ? Math.floor(stringChunksCount / this.options.splitStringsChunkLength)
            : this.options.splitStringsChunkLength;

        // pass #2: split large chunks on a chunks with length of min length === `splitStringsChunkLength`
        const secondPassChunksNode: ESTree.Node = estraverse.replace(firstPassChunksNode, {
            // eslint-disable-next-line @typescript-eslint/no-shadow
            enter: (node: ESTree.Node) => {
                if (NodeGuards.isLiteralNode(node)) {
                    return this.transformLiteralNodeByChunkLength(
                        node,
                        minSecondPathChunkLength
                    )[0];
                }
            }
        });

        NodeUtils.parentizeNode(secondPassChunksNode, parentNode);
        NodeUtils.parentizeAst(secondPassChunksNode);

        return secondPassChunksNode;
    }

    /**
     * @param {Literal} literalNode
     * @param {number} chunkLength
     * @returns {[resultNode: Node, stringChunks: string[]]}
     */
    private transformLiteralNodeByChunkLength (
        literalNode: ESTree.Literal,
        chunkLength: number
    ): [resultNode: ESTree.Node, stringChunks: string[]] {
        if (!NodeLiteralUtils.isStringLiteralNode(literalNode)) {
            return [literalNode, []];
        }

        const valueLength: number = stringz.length(literalNode.value);

        if (chunkLength >= valueLength) {
            return [literalNode, []];
        }

        const stringChunks: string[] = SplitStringTransformer.chunkString(
            literalNode.value,
            valueLength,
            chunkLength
        );

        return [
            this.transformStringChunksToBinaryExpressionNode(stringChunks),
            stringChunks
        ];
    }

    /**
     * @param {string[]} chunks
     * @returns {BinaryExpression}
     */
    private transformStringChunksToBinaryExpressionNode (chunks: string[]): ESTree.BinaryExpression {
        const firstChunk: string | undefined = chunks.shift();
        const secondChunk: string | undefined = chunks.shift();

        if (!firstChunk || !secondChunk) {
            throw new Error('First and second chunks values should not be empty');
        }

        const initialBinaryExpressionNode: ESTree.BinaryExpression = NodeFactory.binaryExpressionNode(
            '+',
            NodeFactory.literalNode(firstChunk),
            NodeFactory.literalNode(secondChunk)
        );

        return chunks.reduce<ESTree.BinaryExpression>(
            (binaryExpressionNode: ESTree.BinaryExpression, chunk: string) => {
                const chunkLiteralNode: ESTree.Literal = NodeFactory.literalNode(chunk);

                return NodeFactory.binaryExpressionNode(
                    '+',
                    binaryExpressionNode,
                    chunkLiteralNode
                );
            },
            initialBinaryExpressionNode
        );
    }
}
