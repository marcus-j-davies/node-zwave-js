import * as fs from "fs";
import * as tsutils from "tsutils/typeguard/3.0";
import ts from "typescript";
import type { Reason } from "./reason";
import type {
	FileSpecificVisitorContext,
	PartialVisitorContext,
	VisitorContext,
} from "./visitor-context";

/**
 * a pair of {@link ts.TemplateLiteralType.texts} and the `intrinsicName`s for {@link ts.TemplateLiteralType.types},
 * @see https://github.com/microsoft/TypeScript/pull/40336
 */
export type TemplateLiteralPair = [
	string,
	"string" | "number" | "bigint" | "any" | "undefined" | "null" | undefined,
];

export const objectIdentifier = ts.factory.createIdentifier("$o");
export const pathIdentifier = ts.factory.createIdentifier("path");
const keyIdentifier = ts.factory.createIdentifier("key");

export function checkIsClass(
	type: ts.ObjectType,
	visitorContext: VisitorContext,
): boolean {
	// Hacky: using internal TypeScript API.
	if (
		"isArrayType" in visitorContext.checker
		&& (visitorContext.checker as any).isArrayType(type)
	) {
		return false;
	}
	if (
		"isArrayLikeType" in visitorContext.checker
		&& (visitorContext.checker as any).isArrayLikeType(type)
	) {
		return false;
	}

	let hasConstructSignatures = false;
	if (
		type.symbol !== undefined
		&& type.symbol.valueDeclaration !== undefined
		&& ts.isVariableDeclaration(type.symbol.valueDeclaration)
		&& type.symbol.valueDeclaration.type
	) {
		const variableDeclarationType = visitorContext.checker
			.getTypeAtLocation(
				type.symbol.valueDeclaration.type,
			);
		const constructSignatures = variableDeclarationType
			.getConstructSignatures();
		hasConstructSignatures = constructSignatures.length >= 1;
	}

	return type.isClass() || hasConstructSignatures;
}

export function checkIsDateClass(type: ts.ObjectType): boolean {
	return (
		type.symbol !== undefined
		&& type.symbol.valueDeclaration !== undefined
		&& type.symbol.escapedName === "Date"
		&& !!(
			ts.getCombinedModifierFlags(type.symbol.valueDeclaration)
			& ts.ModifierFlags.Ambient
		)
	);
}

export function checkIsNodeBuffer(type: ts.ObjectType): boolean {
	return (
		type.symbol !== undefined
		&& type.symbol.valueDeclaration !== undefined
		&& type.symbol.escapedName === "Buffer"
		&& !!(
			ts.getCombinedModifierFlags(type.symbol.valueDeclaration)
			& ts.ModifierFlags.Ambient
		)
	);
}

export function checkIsIgnoredIntrinsic(type: ts.ObjectType): boolean {
	return (
		type.symbol !== undefined
		&& type.symbol.valueDeclaration !== undefined
		&& ["Set", "Map"].includes(type.symbol.name)
		&& !!(
			ts.getCombinedModifierFlags(type.symbol.valueDeclaration)
			& ts.ModifierFlags.Ambient
		)
	);
}

export function isNumericEnum(
	type: ts.Type,
): type is ts.UnionType & { types: ts.NumberLiteralType[] } {
	return (
		!!(type.flags & ts.TypeFlags.EnumLiteral)
		&& type.isUnion()
		&& type.types.every((t) => t.isNumberLiteral())
	);
}

export function setFunctionIfNotExists(
	name: string,
	visitorContext: VisitorContext,
	factory: () => ts.FunctionDeclaration,
): string {
	if (!visitorContext.functionNames.has(name)) {
		visitorContext.functionNames.add(name);
		visitorContext.functionMap.set(name, factory());
	}
	return name;
}

interface PropertyInfo {
	name: string;
	type: ts.Type | undefined; // undefined iff isMethod===true
	isMethod: boolean;
	isFunction: boolean;
	isSymbol: boolean;
	optional: boolean;
}

export function getPropertyInfo(
	parentType: ts.Type,
	symbol: ts.Symbol,
	visitorContext: VisitorContext,
): PropertyInfo {
	const name: string | undefined = symbol.name;
	if (name === undefined) {
		throw new Error("Missing name in property symbol.");
	}

	let propertyType: ts.Type | undefined = undefined;
	let isMethod: boolean | undefined = undefined;
	let isFunction: boolean | undefined = undefined;
	let optional: boolean | undefined = undefined;

	if ("valueDeclaration" in symbol && symbol.valueDeclaration) {
		// Attempt to get it from 'valueDeclaration'

		const valueDeclaration = symbol.valueDeclaration;
		if (
			!ts.isPropertySignature(valueDeclaration)
			&& !ts.isMethodSignature(valueDeclaration)
		) {
			throw new Error(
				`Unsupported declaration kind: ${valueDeclaration.kind}`,
			);
		}
		isMethod = ts.isMethodSignature(valueDeclaration);
		isFunction = valueDeclaration.type !== undefined
			&& ts.isFunctionTypeNode(valueDeclaration.type);
		if (valueDeclaration.type === undefined) {
			if (!isMethod) {
				throw new Error("Found property without type.");
			}
		} else {
			propertyType = visitorContext.checker.getTypeFromTypeNode(
				valueDeclaration.type,
			);
		}
		optional = !!valueDeclaration.questionToken;
	} else if ("type" in symbol) {
		// Attempt to get it from 'type'

		propertyType = (symbol as { type?: ts.Type }).type;
		isMethod = false;
		isFunction = false;
		optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0;
	} else if ("getTypeOfPropertyOfType" in visitorContext.checker) {
		// Attempt to get it from 'visitorContext.checker.getTypeOfPropertyOfType'

		propertyType = (
			visitorContext.checker as unknown as {
				getTypeOfPropertyOfType: (
					type: ts.Type,
					name: string,
				) => ts.Type | undefined;
			}
		).getTypeOfPropertyOfType(parentType, name);
		isMethod = false;
		isFunction = false;
		optional = (symbol.flags & ts.SymbolFlags.Optional) !== 0;
	}

	if (
		optional !== undefined
		&& isMethod !== undefined
		&& isFunction !== undefined
	) {
		return {
			name,
			type: propertyType,
			isMethod,
			isFunction,
			isSymbol: name.startsWith("__@"),
			optional,
		};
	}

	throw new Error("Expected a valueDeclaration or a property type.");
}

export function getTypeAliasMapping(
	type: ts.TypeReference,
): Map<ts.Type, ts.Type> {
	const mapping: Map<ts.Type, ts.Type> = new Map();
	if (
		type.aliasTypeArguments !== undefined
		&& type.target.aliasTypeArguments !== undefined
	) {
		const typeParameters = type.target.aliasTypeArguments;
		const typeArguments = type.aliasTypeArguments;
		for (let i = 0; i < typeParameters.length; i++) {
			if (typeParameters[i] !== typeArguments[i]) {
				mapping.set(typeParameters[i], typeArguments[i]);
			}
		}
	}
	return mapping;
}

export function getTypeReferenceMapping(
	type: ts.TypeReference,
	visitorContext: VisitorContext,
): Map<ts.Type, ts.Type> {
	const mapping: Map<ts.Type, ts.Type> = new Map();
	(function checkBaseTypes(type: ts.TypeReference) {
		if (tsutils.isInterfaceType(type.target)) {
			const baseTypes = visitorContext.checker.getBaseTypes(type.target);
			for (const baseType of baseTypes) {
				if (
					baseType.aliasTypeArguments
					&& visitorContext.previousTypeReference !== baseType
					&& (baseType as ts.TypeReference).target
				) {
					const typeReference = baseType as ts.TypeReference;
					if (
						typeReference.aliasTypeArguments !== undefined
						&& typeReference.target.aliasTypeArguments !== undefined
					) {
						const typeParameters =
							typeReference.target.aliasTypeArguments;
						const typeArguments = typeReference.aliasTypeArguments;
						for (let i = 0; i < typeParameters.length; i++) {
							if (typeParameters[i] !== typeArguments[i]) {
								mapping.set(
									typeParameters[i],
									typeArguments[i],
								);
							}
						}
					}
				}

				if (
					tsutils.isTypeReference(baseType)
					&& baseType.target.typeParameters !== undefined
					&& baseType.typeArguments !== undefined
				) {
					const typeParameters = baseType.target.typeParameters;
					const typeArguments = baseType.typeArguments;
					for (let i = 0; i < typeParameters.length; i++) {
						if (typeParameters[i] !== typeArguments[i]) {
							mapping.set(typeParameters[i], typeArguments[i]);
						}
					}
					checkBaseTypes(baseType);
				}
			}
		}
	})(type);
	if (
		type.target.typeParameters !== undefined
		&& type.typeArguments !== undefined
	) {
		const typeParameters = type.target.typeParameters;
		const typeArguments = type.typeArguments;
		for (let i = 0; i < typeParameters.length; i++) {
			if (typeParameters[i] !== typeArguments[i]) {
				mapping.set(typeParameters[i], typeArguments[i]);
			}
		}
	}
	return mapping;
}

export function getResolvedTypeParameter(
	type: ts.Type,
	visitorContext: VisitorContext,
): ts.Type | undefined {
	let mappedType: ts.Type | undefined;
	for (let i = visitorContext.typeMapperStack.length - 1; i >= 0; i--) {
		mappedType = visitorContext.typeMapperStack[i].get(type);
		if (mappedType !== undefined) {
			break;
		}
	}
	return mappedType || type.getDefault();
}

export function getFunctionFunction(visitorContext: VisitorContext): string {
	const f = visitorContext.factory;
	const name = "_function";
	return setFunctionIfNotExists(name, visitorContext, () => {
		return createAssertionFunction(
			f.createStrictInequality(
				f.createTypeOfExpression(objectIdentifier),
				f.createStringLiteral("function"),
			),
			{ type: "function" },
			name,
			visitorContext,
			createStrictNullCheckStatement(objectIdentifier, visitorContext),
		);
	});
}

export function getStringFunction(visitorContext: VisitorContext): string {
	const f = visitorContext.factory;
	const name = "_string";
	return setFunctionIfNotExists(name, visitorContext, () => {
		return createAssertionFunction(
			f.createStrictInequality(
				f.createTypeOfExpression(objectIdentifier),
				f.createStringLiteral("string"),
			),
			{ type: "string" },
			name,
			visitorContext,
			createStrictNullCheckStatement(objectIdentifier, visitorContext),
		);
	});
}

export function getBooleanFunction(visitorContext: VisitorContext): string {
	const f = visitorContext.factory;
	const name = "_boolean";
	return setFunctionIfNotExists(name, visitorContext, () => {
		return createAssertionFunction(
			f.createStrictInequality(
				f.createTypeOfExpression(objectIdentifier),
				f.createStringLiteral("boolean"),
			),
			{ type: "boolean" },
			name,
			visitorContext,
			createStrictNullCheckStatement(objectIdentifier, visitorContext),
		);
	});
}

export function getBigIntFunction(visitorContext: VisitorContext): string {
	const f = visitorContext.factory;
	const name = "_bigint";
	return setFunctionIfNotExists(name, visitorContext, () => {
		return createAssertionFunction(
			f.createStrictInequality(
				f.createTypeOfExpression(objectIdentifier),
				f.createStringLiteral("bigint"),
			),
			{ type: "big-int" },
			name,
			visitorContext,
			createStrictNullCheckStatement(objectIdentifier, visitorContext),
		);
	});
}

export function getNumberFunction(visitorContext: VisitorContext): string {
	const f = visitorContext.factory;
	const name = "_number";
	return setFunctionIfNotExists(name, visitorContext, () => {
		return createAssertionFunction(
			f.createStrictInequality(
				f.createTypeOfExpression(objectIdentifier),
				f.createStringLiteral("number"),
			),
			{ type: "number" },
			name,
			visitorContext,
			createStrictNullCheckStatement(objectIdentifier, visitorContext),
		);
	});
}

export function getUndefinedFunction(visitorContext: VisitorContext): string {
	const f = visitorContext.factory;
	const name = "_undefined";
	return setFunctionIfNotExists(name, visitorContext, () => {
		return createAssertionFunction(
			f.createStrictInequality(
				objectIdentifier,
				f.createIdentifier("undefined"),
			),
			{ type: "undefined" },
			name,
			visitorContext,
			createStrictNullCheckStatement(objectIdentifier, visitorContext),
		);
	});
}

export function getNullFunction(visitorContext: VisitorContext): string {
	const f = visitorContext.factory;
	const name = "_null";
	return setFunctionIfNotExists(name, visitorContext, () => {
		const strictNullChecks =
			visitorContext.compilerOptions.strictNullChecks !== undefined
				? visitorContext.compilerOptions.strictNullChecks
				: !!visitorContext.compilerOptions.strict;

		if (!strictNullChecks) {
			return createAcceptingFunction(name);
		}

		return createAssertionFunction(
			f.createStrictInequality(objectIdentifier, f.createNull()),
			{ type: "null" },
			name,
			visitorContext,
			createStrictNullCheckStatement(objectIdentifier, visitorContext),
		);
	});
}

export function getNeverFunction(visitorContext: VisitorContext): string {
	const f = visitorContext.factory;
	const name = "_never";
	return setFunctionIfNotExists(name, visitorContext, () => {
		return f.createFunctionDeclaration(
			undefined,
			undefined,
			name,
			undefined,
			[
				f.createParameterDeclaration(
					undefined,
					undefined,
					objectIdentifier,
					undefined,
					undefined,
					undefined,
				),
			],
			undefined,
			f.createBlock(
				[
					f.createReturnStatement(
						createErrorObject({ type: "never" }, visitorContext),
					),
				],
				true,
			),
		);
	});
}

export function getUnknownFunction(visitorContext: VisitorContext): string {
	const name = "_unknown";
	return setFunctionIfNotExists(name, visitorContext, () => {
		return createAcceptingFunction(name);
	});
}

export function getAnyFunction(visitorContext: VisitorContext): string {
	const name = "_any";
	return setFunctionIfNotExists(name, visitorContext, () => {
		return createAcceptingFunction(name);
	});
}

export function getIgnoredTypeFunction(visitorContext: VisitorContext): string {
	const name = "_ignore";
	return setFunctionIfNotExists(name, visitorContext, () => {
		return createAcceptingFunction(name);
	});
}

export function createBinaries(
	expressions: ts.Expression[],
	operator: ts.BinaryOperator,
	baseExpression?: ts.Expression,
): ts.Expression {
	if (expressions.length >= 1 || baseExpression === undefined) {
		return expressions.reduce((previous, expression) =>
			ts.factory.createBinaryExpression(previous, operator, expression)
		);
	} else {
		return baseExpression;
	}
}

export function createAcceptingFunction(
	functionName: string,
): ts.FunctionDeclaration {
	return ts.factory.createFunctionDeclaration(
		undefined,
		undefined,
		functionName,
		undefined,
		[],
		undefined,
		ts.factory.createBlock(
			[ts.factory.createReturnStatement(ts.factory.createNull())],
			true,
		),
	);
}

export function createConjunctionFunction(
	functionNames: string[],
	functionName: string,
	extraStatements?: ts.Statement[],
): ts.FunctionDeclaration {
	const conditionsIdentifier = ts.factory.createIdentifier("conditions");
	const conditionIdentifier = ts.factory.createIdentifier("condition");
	const errorIdentifier = ts.factory.createIdentifier("error");
	return ts.factory.createFunctionDeclaration(
		undefined,
		undefined,
		functionName,
		undefined,
		[
			ts.factory.createParameterDeclaration(
				undefined,
				undefined,
				objectIdentifier,
				undefined,
				undefined,
				undefined,
			),
		],
		undefined,
		ts.factory.createBlock(
			[
				ts.factory.createVariableStatement(
					undefined,
					ts.factory.createVariableDeclarationList(
						[
							ts.factory.createVariableDeclaration(
								conditionsIdentifier,
								undefined,
								undefined,
								ts.factory.createArrayLiteralExpression(
									functionNames.map((functionName) =>
										ts.factory.createIdentifier(
											functionName,
										)
									),
								),
							),
						],
						ts.NodeFlags.Const,
					),
				),
				ts.factory.createForOfStatement(
					undefined,
					ts.factory.createVariableDeclarationList(
						[
							ts.factory.createVariableDeclaration(
								conditionIdentifier,
								undefined,
								undefined,
							),
						],
						ts.NodeFlags.Const,
					),
					conditionsIdentifier,
					ts.factory.createBlock(
						[
							ts.factory.createVariableStatement(
								undefined,
								ts.factory.createVariableDeclarationList(
									[
										ts.factory.createVariableDeclaration(
											errorIdentifier,
											undefined,
											undefined,
											ts.factory.createCallExpression(
												conditionIdentifier,
												undefined,
												[objectIdentifier],
											),
										),
									],
									ts.NodeFlags.Const,
								),
							),
							ts.factory.createIfStatement(
								errorIdentifier,
								ts.factory.createReturnStatement(
									errorIdentifier,
								),
							),
						],
						true,
					),
				),
				...(extraStatements || []),
				ts.factory.createReturnStatement(ts.factory.createNull()),
			],
			true,
		),
	);
}

export function createDisjunctionFunction(
	functionNames: string[],
	functionName: string,
	visitorContext: VisitorContext,
): ts.FunctionDeclaration {
	const f = visitorContext.factory;

	// Not sure why this was here. It created spurious uncalled _null methods
	//
	// if (functionNames.length === 2) {
	// 	const nullTypeCheckFunction = getNullFunction(visitorContext);
	// 	const nullIndex = functionNames.indexOf(nullTypeCheckFunction);
	// 	if (nullIndex > -1) {
	// 		return createNullableTypeCheck(
	// 			functionNames[1 - nullIndex],
	// 			functionName,
	// 		);
	// 	}
	// }

	const conditionsIdentifier = f.createIdentifier("conditions");
	const conditionIdentifier = f.createIdentifier("condition");
	const errorIdentifier = f.createIdentifier("error");
	return f.createFunctionDeclaration(
		undefined,
		undefined,
		functionName,
		undefined,
		[
			f.createParameterDeclaration(
				undefined,
				undefined,
				objectIdentifier,
				undefined,
				undefined,
				undefined,
			),
		],
		undefined,
		f.createBlock(
			[
				f.createVariableStatement(
					undefined,
					f.createVariableDeclarationList(
						[
							f.createVariableDeclaration(
								conditionsIdentifier,
								undefined,
								undefined,
								f.createArrayLiteralExpression(
									functionNames.map((functionName) =>
										f.createIdentifier(functionName)
									),
								),
							),
						],
						ts.NodeFlags.Const,
					),
				),
				f.createForOfStatement(
					undefined,
					f.createVariableDeclarationList(
						[
							f.createVariableDeclaration(
								conditionIdentifier,
								undefined,
								undefined,
							),
						],
						ts.NodeFlags.Const,
					),
					conditionsIdentifier,
					f.createBlock(
						[
							f.createVariableStatement(
								undefined,
								f.createVariableDeclarationList(
									[
										f.createVariableDeclaration(
											errorIdentifier,
											undefined,
											undefined,
											f.createCallExpression(
												conditionIdentifier,
												undefined,
												[objectIdentifier],
											),
										),
									],
									ts.NodeFlags.Const,
								),
							),
							f.createIfStatement(
								f.createLogicalNot(errorIdentifier),
								f.createReturnStatement(f.createNull()),
							),
						],
						true,
					),
				),
				f.createReturnStatement(
					createErrorObject({ type: "union" }, visitorContext),
				),
			],
			true,
		),
	);
}

// function createNullableTypeCheck(
// 	typeCheckFunction: string,
// 	functionName: string,
// ) {
// 	return ts.createFunctionDeclaration(
// 		undefined,
// 		undefined,
// 		undefined,
// 		functionName,
// 		undefined,
// 		[
// 			ts.createParameter(
// 				undefined,
// 				undefined,
// 				undefined,
// 				objectIdentifier,
// 				undefined,
// 				undefined,
// 				undefined,
// 			),
// 		],
// 		undefined,
// 		ts.createBlock(
// 			[
// 				ts.createIf(
// 					ts.createStrictEquality(objectIdentifier, ts.createNull()),
// 					ts.createReturn(ts.createNull()),
// 					ts.createReturn(
// 						ts.createCall(
// 							ts.createIdentifier(typeCheckFunction),
// 							undefined,
// 							[objectIdentifier],
// 						),
// 					),
// 				),
// 			],
// 			true,
// 		),
// 	);
// }

export function createStrictNullCheckStatement(
	identifier: ts.Identifier,
	visitorContext: VisitorContext,
): ts.Statement {
	const f = visitorContext.factory;
	if (visitorContext.compilerOptions.strictNullChecks !== false) {
		return f.createEmptyStatement();
	} else {
		return f.createIfStatement(
			f.createBinaryExpression(
				f.createStrictEquality(identifier, f.createNull()),
				ts.SyntaxKind.BarBarToken,
				f.createStrictEquality(
					identifier,
					f.createIdentifier("undefined"),
				),
			),
			f.createReturnStatement(f.createNull()),
		);
	}
}

export function createAssertionFunction(
	failureCondition: ts.Expression,
	expected: Reason,
	functionName: string,
	visitorContext: VisitorContext,
	...otherStatements: ts.Statement[]
): ts.FunctionDeclaration {
	const f = visitorContext.factory;
	return f.createFunctionDeclaration(
		undefined,
		undefined,
		functionName,
		undefined,
		[
			f.createParameterDeclaration(
				undefined,
				undefined,
				objectIdentifier,
				undefined,
				undefined,
				undefined,
			),
		],
		undefined,
		f.createBlock(
			[
				...otherStatements.filter((o) => !ts.isEmptyStatement(o)),
				f.createReturnStatement(
					f.createConditionalExpression(
						failureCondition,
						f.createToken(ts.SyntaxKind.QuestionToken),
						createErrorObject(expected, visitorContext),
						f.createToken(ts.SyntaxKind.ColonToken),
						f.createNull(),
					),
				),
			],
			true,
		),
	);
}

export function createSuperfluousPropertiesLoop(
	propertyNames: string[],
	visitorContext: VisitorContext,
): ts.Statement {
	const f = visitorContext.factory;
	return f.createForOfStatement(
		undefined,
		f.createVariableDeclarationList(
			[f.createVariableDeclaration(keyIdentifier, undefined, undefined)],
			ts.NodeFlags.Const,
		),
		f.createCallExpression(
			f.createPropertyAccessExpression(
				f.createIdentifier("Object"),
				"keys",
			),
			undefined,
			[objectIdentifier],
		),
		f.createBlock(
			[
				f.createIfStatement(
					createBinaries(
						propertyNames.map((propertyName) =>
							f.createStrictInequality(
								keyIdentifier,
								f.createStringLiteral(propertyName),
							)
						),
						ts.SyntaxKind.AmpersandAmpersandToken,
						f.createTrue(),
					),
					f.createReturnStatement(
						createErrorObject(
							{ type: "superfluous-property" },
							visitorContext,
						),
					),
				),
			],
			true,
		),
	);
}

export function isBigIntType(type: ts.Type): boolean {
	if ("BigInt" in ts.TypeFlags) {
		return !!((ts.TypeFlags as any).BigInt & type.flags);
	} else {
		return false;
	}
}

function createAssertionString(reason: string | ts.Expression): ts.Expression {
	if (typeof reason === "string") {
		return createBinaries(
			[
				ts.factory.createStringLiteral("validation failed at "),
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(
						pathIdentifier,
						"join",
					),
					undefined,
					[ts.factory.createStringLiteral(".")],
				),
				ts.factory.createStringLiteral(`: ${reason}`),
			],
			ts.SyntaxKind.PlusToken,
		);
	} else {
		return createBinaries(
			[
				ts.factory.createStringLiteral("validation failed at "),
				ts.factory.createCallExpression(
					ts.factory.createPropertyAccessExpression(
						pathIdentifier,
						"join",
					),
					undefined,
					[ts.factory.createStringLiteral(".")],
				),
				ts.factory.createStringLiteral(`: `),
				reason,
			],
			ts.SyntaxKind.PlusToken,
		);
	}
}

export function createErrorObject(
	reason: Reason,
	visitorContext: VisitorContext,
): ts.Expression {
	const f = visitorContext.factory;
	if (visitorContext.options.emitDetailedErrors === false) {
		return f.createObjectLiteralExpression([]);
	}
	return f.createObjectLiteralExpression([
		f.createPropertyAssignment("message", createErrorMessage(reason)),
		f.createPropertyAssignment(
			"path",
			f.createCallExpression(
				f.createPropertyAccessExpression(pathIdentifier, "slice"),
				undefined,
				undefined,
			),
		),
		f.createPropertyAssignment(
			"reason",
			serializeObjectToExpression(reason),
		),
	]);
}

function serializeObjectToExpression(object: unknown): ts.Expression {
	if (typeof object === "string") {
		return ts.factory.createStringLiteral(object);
	} else if (typeof object === "number") {
		return ts.factory.createNumericLiteral(object.toString());
	} else if (typeof object === "boolean") {
		return object ? ts.factory.createTrue() : ts.factory.createFalse();
	} else if (typeof object === "bigint") {
		return ts.factory.createBigIntLiteral(object.toString());
	} else if (typeof object === "undefined") {
		return ts.factory.createIdentifier("undefined");
	} else if (typeof object === "object") {
		if (object === null) {
			return ts.factory.createNull();
		} else if (Array.isArray(object)) {
			return ts.factory.createArrayLiteralExpression(
				object.map((item) => serializeObjectToExpression(item)),
			);
		} else {
			return ts.factory.createObjectLiteralExpression(
				Object.keys(object).map((key) => {
					const value = (object as { [Key: string]: unknown })[key];
					return ts.factory.createPropertyAssignment(
						key,
						serializeObjectToExpression(value),
					);
				}),
			);
		}
	}
	throw new Error("Cannot serialize object to expression.");
}

function createErrorMessage(reason: Reason): ts.Expression {
	switch (reason.type) {
		case "tuple":
			return createAssertionString(
				`expected an array with length ${reason.minLength}-${reason.maxLength}`,
			);
		case "array":
			return createAssertionString("expected an array");
		case "object":
			return createAssertionString("expected an object");
		case "missing-property":
			return createAssertionString(
				`expected '${reason.property}' in object`,
			);
		case "superfluous-property":
			return createAssertionString(
				createBinaries(
					[
						ts.factory.createStringLiteral(
							`superfluous property '`,
						),
						keyIdentifier,
						ts.factory.createStringLiteral(`' in object`),
					],
					ts.SyntaxKind.PlusToken,
				),
			);
		case "never":
			return createAssertionString("type is never");
		case "union":
			return createAssertionString("there are no valid alternatives");
		case "string":
			return createAssertionString("expected a string");
		case "boolean":
			return createAssertionString("expected a boolean");
		case "big-int":
			return createAssertionString("expected a bigint");
		case "number":
			return createAssertionString("expected a number");
		case "undefined":
			return createAssertionString("expected undefined");
		case "null":
			return createAssertionString("expected null");
		case "object-keyof":
			return createAssertionString(
				`expected ${
					reason.properties
						.map((property) => `'${property}'`)
						.join("|")
				}`,
			);
		case "string-literal":
			return createAssertionString(`expected string '${reason.value}'`);
		case "number-literal":
			return createAssertionString(`expected number '${reason.value}'`);
		case "boolean-literal":
			return createAssertionString(
				`expected ${reason.value ? "true" : "false"}`,
			);
		case "non-primitive":
			return createAssertionString("expected a non-primitive");
		case "date":
			return createAssertionString("expected a Date");
		case "buffer":
			return createAssertionString("expected a Buffer");
		case "class":
			return createAssertionString(
				`expected instance of class '${reason.name}'`,
			);
		case "enum":
			return createAssertionString(
				`expected value from enum '${reason.name}'`,
			);
		case "function":
			return createAssertionString("expected a function");
		case "template-literal":
			return createAssertionString(
				`expected \`${
					reason.value
						.map(
							([text, type]) =>
								text
								+ (typeof type === "undefined"
									? ""
									: "${" + type + "}"),
						)
						.join("")
				}\``,
			);
	}
	throw new Error("Not implemented");
}

export function getIntrinsicName(type: ts.Type): string | undefined {
	// Using internal TypeScript API, hacky.
	return (type as { intrinsicName?: string }).intrinsicName;
}

export function getCanonicalPath(
	path: string,
	context: PartialVisitorContext,
): string {
	if (!context.canonicalPaths.has(path)) {
		context.canonicalPaths.set(path, fs.realpathSync(path));
	}
	return context.canonicalPaths.get(path)!;
}

export function createBlock(
	factory: ts.NodeFactory,
	statements: ts.Statement[],
): ts.Block {
	return factory.createBlock(
		statements.filter((s) => !ts.isEmptyStatement(s)),
		true,
	);
}

export function resolveModuleSpecifierForType(
	type: ts.Type,
	visitorContext: FileSpecificVisitorContext,
): string | undefined {
	// @ts-expect-error We're using TS internals here
	const typeId: number = type.id;

	// Prefer cached resolutions
	if (visitorContext.typeIdModuleMap.has(typeId)) {
		return visitorContext.typeIdModuleMap.get(typeId)!;
	}

	// Otherwise scan all imports to determine which one resolves to the same type
	const importDeclarations = visitorContext.sourceFile.statements.filter(
		(n): n is ts.ImportDeclaration => ts.isImportDeclaration(n),
	);
	for (const imp of importDeclarations) {
		if (!imp.importClause?.namedBindings) continue;
		if (!ts.isNamedImports(imp.importClause.namedBindings)) continue;

		// Remember where each type was imported from
		const specifier = (imp.moduleSpecifier as ts.StringLiteral).text;
		for (const e of imp.importClause.namedBindings.elements) {
			const symbol = visitorContext.checker.getSymbolAtLocation(e.name);
			if (!symbol) continue;
			const type = visitorContext.checker.getDeclaredTypeOfSymbol(symbol);
			if (!type) continue;
			// @ts-expect-error We're using TS internals here
			const id: number = type.id;
			if (!visitorContext.typeIdModuleMap.has(id)) {
				visitorContext.typeIdModuleMap.set(id, specifier);
			}
			if (id === typeId) return specifier;
		}
	}
}
