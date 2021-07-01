import expect from "expect";
import {
    AddressType,
    ArrayType,
    ASTContext,
    ASTNodeFactory,
    ASTWriter,
    BoolType,
    BytesType,
    compileSourceString,
    DefaultASTWriterMapping,
    forAll,
    IntType,
    PrettyFormatter,
    SourceUnit,
    StringType,
    StructDefinition,
    TypeNode,
    UserDefinedType,
    VariableDeclaration
} from "solc-typed-ast";
import { generateMapLibrary, generateUtilsContract, interposeMap } from "../../src";
import { pp, single } from "../../src/util";
import { toAst } from "../integration/utils";
import { Config, executeTestSuiteInternal } from "../integration/vm";
import { makeInstrumentationCtx } from "./utils";

const libGenTests: [string, Array<[TypeNode, TypeNode | ((s: SourceUnit) => TypeNode)]>] = [
    `
pragma solidity 0.8.4;
struct Foo {
    uint x;
}

struct Bar {
    mapping(uint => uint) t;
}
`,
    [
        [new IntType(256, false), new IntType(8, true)],
        [new IntType(256, false), new StringType()],
        [new StringType(), new StringType()],
        [new StringType(), new BytesType()],
        [new BytesType(), new ArrayType(new AddressType(true))],
        [new BytesType(), new ArrayType(new BoolType(), BigInt(3))],
        [
            new AddressType(true),
            (s: SourceUnit) =>
                new UserDefinedType(
                    "Foo",
                    single(
                        s.getChildrenBySelector(
                            (child) => child instanceof StructDefinition && child.name === "Foo"
                        )
                    ) as StructDefinition
                )
        ]
    ]
];

describe("Maps with keys library generation", () => {
    const [content, testTypes] = libGenTests;
    let unit: SourceUnit;
    let ctx: ASTContext;
    let version: string;
    let writer: ASTWriter;

    before("", () => {
        const res = toAst("sample.sol", content);
        unit = single(res.units);
        ctx = res.reader.context;
        version = res.compilerVersion;

        writer = new ASTWriter(DefaultASTWriterMapping, new PrettyFormatter(4, 0), version);
    });

    for (const [keyT, valueArg] of testTypes) {
        it(`Can generate compiling map library for ${keyT.pp()}->${
            valueArg instanceof TypeNode ? valueArg.pp() : "?"
        }`, () => {
            const factory = new ASTNodeFactory(ctx);
            const valueT = valueArg instanceof TypeNode ? valueArg : valueArg(unit);
            const lib = generateMapLibrary(factory, keyT, valueT, unit, version);

            const src = writer.write(lib);
            const newContent = content + "\n" + src;

            console.error(newContent);
            const compRes = compileSourceString("foo.sol", newContent, version, []);

            expect(compRes.data.contracts["foo.sol"]).toBeDefined();
            expect(compRes.data.contracts["foo.sol"][lib.name]).toBeDefined();
            expect(forAll(compRes.data.errors, (error: any) => error.severity === "warning"));
        });
    }
});

const interposingTests: Array<[string, string, Array<[string, Array<string | null>]>]> = [
    [
        "Maps with simple assignments",
        `
pragma solidity 0.8.4;
contract Foo {
    mapping(uint => uint) x;
    function main() public {
        uint a;
        x[0] = 1;
        assert(x[0] == 1);
        x[1] = a = 2;
        assert(x[1] == 2);
        //@todo uncomment
        x[3] = x[2] = 1;


        assert(1 == x[0]++ && x[0] == 2);
        assert(3 == ++x[0] && x[0] == 3);
        assert(2 == --x[0] && x[0] == 2);
        assert(2 == x[0]-- && x[0] == 1);


        delete x[3];
        assert(x[3] == 0);
    }
}
`,
        [["x", []]]
    ],
    [
        "Map index in the index location",
        `
pragma solidity 0.8.4;
contract Foo {
    mapping(uint => uint) x;
    function main() public {
        uint a;
        x[0] = 1;
        x[1] = 2;
        assert(x[0] == 1);
        assert(x[x[0]] == 2);
    }
}
`,
        [["x", []]]
    ],
    [
        "Both maps that should and shouldn't be replaced",
        `
pragma solidity 0.8.4;
contract Foo {
    mapping(uint => uint) x;
    mapping(uint => uint) y;

    function main() public {
        uint a;
        x[0] = 1;
        x[1] = 2;
        assert(x[0] == 1);
        assert(x[x[0]] == 2);

        y[0] = 1;
        y[1] = 2;

        assert(y[0] == 1);
        assert(y[x[0]] == 2);
        assert(x[y[0]] == 2);
    }
}
`,
        [["x", []]]
    ],
    [
        "Nested mappings",
        `
pragma solidity 0.8.4;
contract Foo {
    mapping(uint => mapping(address => bool)) x;
    mapping(uint => mapping(bool => string)) y;
    mapping(uint => mapping(int8 => uint)) z;
    mapping(uint => uint) w;

    function main() public {
        x[0][address(0x0)] = true;
        bool t = x[0][address(0x0)];
        x[1][address(0x1)] = x[0][address(0x0)];

        y[1][false] = "hi";
        y[2][true] = y[1][false];
        assert(keccak256(bytes(y[2][true])) == keccak256(bytes("hi")));
        
        z[0][1] = 1;
        z[z[0][1]][2] = 2;
        
        assert(z[1][2] == 2);

        z[w[0] = w[1] + 3][int8(uint8(w[2]))] = 42;
        assert(z[3][0] == 42);
    }
}
`,
        [
            ["x", [null]],
            ["y", []],
            ["z", []],
            ["z", [null]],
            ["w", []]
        ]
    ],
    [
        "Maps with arrays",
        `
pragma solidity 0.8.4;
contract Foo {
    mapping(uint => uint[]) x;

    function main() public {
        x[0] = [1,2,3];
        assert(x[0].length == 3);

        x[1] = x[0];
        x[1].push(4);
        assert(x[1].length == 4 && x[1][3] == 4);

        x[1].pop();
        assert(x[1].length == 3);

        uint[] memory a = new uint[](3);
        a[0] = 2; a[1] = 4; a[2] = 6;
        x[2] = a;
        assert(x[2].length == 3 && x[2][2] == 6);
    }
}
`,
        [["x", []]]
    ],
    [
        "Partial state var update",
        `
pragma solidity 0.8.4;
contract Foo {
    struct Moo {
        mapping(uint => uint[]) x;
        mapping(uint => uint[]) y;
    }

    Moo m;

    function main() public {
        m.y[0] = [1,2,3];
        assert(m.y[0].length == 3);

        m.x[1] = m.y[0];
        m.x[1].push(4);
        assert(m.x[1].length == 4 && m.x[1][3] == 4);

        m.x[1].pop();
        assert(m.x[1].length == 3);

        uint[] memory a = new uint[](3);
        a[0] = 2; a[1] = 4; a[2] = 6;
        m.x[2] = a;
        assert(m.x[2].length == 3 && m.x[2][2] == 6);
    }
}
`,
        [["m", ["x"]]]
    ],
    [
        "Older inline initializer",
        `
pragma solidity 0.6.4;
contract Foo {
    struct Moo {
        uint x;
        mapping(uint => uint[]) y;
    }

    Moo m = Moo(1);

    function main() public {
        assert(m.x == 1 && m.y[0].length == 0);
        m.y[0] = [1,2,3];
        assert(m.y[0].length == 3);

        m = Moo(2);
        assert(m.x == 2 && m.y[0].length == 3);
    }
}
`,
        [["m", ["y"]]]
    ],
    [
        "Public vars",
        `
pragma solidity 0.8.4;
contract Foo {
    enum E { A, B, C }
    mapping (uint => uint) public x;
    mapping (uint => mapping(uint => uint)) public y;
    mapping (string => uint[]) public z;
    mapping (bytes => E) public u;

    function main() public {
        x[2] = 5;
        assert(x[2] == 5);
        y[0][1] = 6;
        assert(y[0][1] == 6);
        x[1] = y[0][1] + x[2];
        assert(x[1] == 11);
        z["hi"] = [1,2,3];
        assert(z["hi"].length == 3 && z["hi"][2] == 3);
        u[hex"abcd"] = E.A;
        assert(u[hex"abcd"] == E.A);
    }
}
`,
        [
            ["x", []],
            ["y", []],
            ["y", [null]],
            ["z", []],
            ["u", []]
        ]
    ]
];

describe("Interposing on a map", () => {
    for (const [name, sample, svs] of interposingTests) {
        let newContent: string;

        it(`Code compiles after interposing on ${pp(svs)} in sample ${name}`, () => {
            const res = toAst(name, sample);
            const unit = single(res.units);
            const ctx = res.reader.context;
            const version = res.compilerVersion;
            const factory = new ASTNodeFactory(ctx);
            const instrCtx = makeInstrumentationCtx(
                [unit],
                factory,
                new Map([[name, sample]]),
                "log",
                version
            );
            const writer: ASTWriter = new ASTWriter(
                DefaultASTWriterMapping,
                new PrettyFormatter(4, 0),
                version
            );
            const contract = single(unit.vContracts);

            generateUtilsContract(
                factory,
                "__scribble_ReentrancyUtils.sol",
                "__scribble_ReentrancyUtils.sol",
                version,
                instrCtx
            );

            const targets: Array<
                [VariableDeclaration, Array<string | null>]
            > = svs.map(([svName, path]) => [
                single(contract.vStateVariables.filter((v) => v.name == svName)),
                path
            ]);

            interposeMap(instrCtx, targets, [unit]);

            newContent = [unit, instrCtx.utilsUnit].map((unit) => writer.write(unit)).join("\n");
            console.error(newContent);
            const compRes = compileSourceString("foo.sol", newContent, version, []);

            expect(compRes.data.contracts["foo.sol"]).toBeDefined();
            expect(forAll(compRes.data.errors, (error: any) => error.severity === "warning"));
        });

        it(`Interposed code executes successfully in sample ${name}`, () => {
            const cfg: Config = {
                file: "sample.sol",
                contents: newContent,
                steps: [
                    {
                        act: "createUser",
                        alias: "owner",
                        options: {
                            balance: 1000e18
                        }
                    },
                    {
                        act: "deployContract",
                        contract: "Foo",
                        user: "owner",
                        alias: "instance1"
                    },
                    {
                        act: "txCall",
                        user: "owner",
                        contract: "instance1",

                        method: "main"
                    }
                ]
            };

            executeTestSuiteInternal("foo.json", cfg);
        });
    }
});
