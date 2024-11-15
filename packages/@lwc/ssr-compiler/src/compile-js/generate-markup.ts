/*
 * Copyright (c) 2024, salesforce.com, inc.
 * All rights reserved.
 * SPDX-License-Identifier: MIT
 * For full license text, see the LICENSE file in the repo root or https://opensource.org/licenses/MIT
 */

import { parse as pathParse } from 'node:path';
import { is, builders as b } from 'estree-toolkit';
import { esTemplate } from '../estemplate';
import { isIdentOrRenderCall } from '../estree/validators';
import { bImportDeclaration, bImportDefaultDeclaration } from '../estree/builders';
import { bWireAdaptersPlumbing } from './wire';

import type {
    BlockStatement,
    ExportNamedDeclaration,
    Program,
    SimpleCallExpression,
    Identifier,
    MemberExpression,
    Statement,
} from 'estree';
import type { ComponentMetaState } from './types';

/** Node representing `<something>.render()`. */
type RenderCallExpression = SimpleCallExpression & {
    callee: MemberExpression & { property: Identifier & { name: 'render' } };
};

const bGenerateMarkup = esTemplate`
    export async function* generateMarkup(tagName, props, attrs, slotted, parent, scopeToken) {
        attrs = attrs ?? Object.create(null);
        props = props ?? Object.create(null);
        props = __filterProperties(
            props,
            ${/*public fields*/ is.arrayExpression},
            ${/*private fields*/ is.arrayExpression},
        );
        const instance = new ${/* Component class */ is.identifier}({
            tagName: tagName.toUpperCase(),
        });

        __establishContextfulRelationship(parent, instance);
        ${/*connect wire*/ is.statement}

        instance[__SYMBOL__SET_INTERNALS](props, attrs);
        instance.isConnected = true;
        if (instance.connectedCallback) {
            __mutationTracker.enable(instance);
            instance.connectedCallback();
            __mutationTracker.disable(instance);
        }
        const tmplFn = ${isIdentOrRenderCall} ?? __fallbackTmpl;
        yield \`<\${tagName}\`;

        const hostHasScopedStylesheets =
            tmplFn.hasScopedStylesheets ||
            hasScopedStaticStylesheets(${/*component class*/ 2});
        const hostScopeToken = hostHasScopedStylesheets ? tmplFn.stylesheetScopeToken + "-host" : undefined;

        yield* __renderAttrs(instance, attrs, hostScopeToken, scopeToken);
        yield '>';
        yield* tmplFn(props, attrs, slotted, ${/*component class*/ 2}, instance);
        yield \`</\${tagName}>\`;
    }
`<ExportNamedDeclaration>;

const bAssignGenerateMarkupToComponentClass = esTemplate`
    {
        ${/* lwcClassName */ is.identifier}[__SYMBOL__GENERATE_MARKUP] = generateMarkup;
    }
`<BlockStatement>;

/**
 * This builds a generator function `generateMarkup` and adds it to the component JS's
 * compilation output. `generateMarkup` acts as the glue between component JS and its
 * template(s), including:
 *
 *  - managing reflection of attrs & props
 *  - instantiating the component instance
 *  - setting the internal state of that component instance
 *  - invoking component lifecycle methods
 *  - yielding the tag name & attributes
 *  - deferring to the template function for yielding child content
 */
export function addGenerateMarkupExport(
    program: Program,
    state: ComponentMetaState,
    filename: string
) {
    const { hasRenderMethod, privateFields, publicFields, tmplExplicitImports } = state;

    const classIdentifier = b.identifier(state.lwcClassName!);
    const renderCall = hasRenderMethod
        ? (b.callExpression(
              b.memberExpression(b.identifier('instance'), b.identifier('render')),
              []
          ) as RenderCallExpression)
        : b.identifier('tmpl');

    if (!tmplExplicitImports) {
        const defaultTmplPath = `./${pathParse(filename).name}.html`;
        program.body.unshift(bImportDefaultDeclaration('tmpl', defaultTmplPath));
    }

    // If no wire adapters are detected on the component, we don't bother injecting the wire-related code.
    let connectWireAdapterCode: Statement[] = [];
    if (state.wireAdapters.length) {
        connectWireAdapterCode = bWireAdaptersPlumbing(state.wireAdapters);
    }

    program.body.unshift(
        bImportDeclaration([
            {
                fallbackTmpl: '__fallbackTmpl',
                filterProperties: '__filterProperties',
                mutationTracker: '__mutationTracker',
                renderAttrs: '__renderAttrs',
                SYMBOL__SET_INTERNALS: '__SYMBOL__SET_INTERNALS',
                establishContextfulRelationship: '__establishContextfulRelationship',
                connectContext: '__connectContext',
            },
        ])
    );
    program.body.unshift(bImportDeclaration(['hasScopedStaticStylesheets']));
    program.body.push(
        bGenerateMarkup(
            b.arrayExpression(publicFields.map(b.literal)),
            b.arrayExpression(privateFields.map(b.literal)),
            classIdentifier,
            connectWireAdapterCode,
            renderCall
        )
    );
}

/**
 * Attach the `generateMarkup` function to the Component class so that it can be found later
 * during `renderComponent`.
 */
export function assignGenerateMarkupToComponent(program: Program, state: ComponentMetaState) {
    program.body.unshift(
        bImportDeclaration([
            {
                SYMBOL__GENERATE_MARKUP: '__SYMBOL__GENERATE_MARKUP',
            },
        ])
    );
    program.body.push(bAssignGenerateMarkupToComponentClass(b.identifier(state.lwcClassName!)));
}
