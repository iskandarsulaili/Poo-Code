import { describe, it, expect } from "vitest";
import { DocGenerator } from "../doc-generator.js";

describe("DocGenerator", () => {
	it("should create instance with default config", () => {
		const dg = new DocGenerator();
		expect(dg).toBeInstanceOf(DocGenerator);
	});

	it("should generate doc update for a symbol", async () => {
		const dg = new DocGenerator();
		const update = await dg.generateDoc("/test.ts", "myFunction", "function myFunction() {}");
		expect(update.filePath).toBe("/test.ts");
		expect(update.symbolName).toBe("myFunction");
		expect(update.newDoc).toBeDefined();
		expect(update.generatedAt).toBeGreaterThan(0);
	});

	it("should detect function kind from code", async () => {
		const dg = new DocGenerator();
		const update = await dg.generateDoc("/test.ts", "myFunc", "function myFunc() { return 1; }");
		expect(update.newDoc).toContain("function");
		expect(update.newDoc).toContain("@param");
		expect(update.newDoc).toContain("@returns");
	});

	it("should detect class kind from code", async () => {
		const dg = new DocGenerator();
		const update = await dg.generateDoc("/test.ts", "MyClass", "class MyClass { }");
		expect(update.newDoc).toContain("class");
		expect(update.newDoc).toContain("@property");
		expect(update.newDoc).toContain("@method");
	});

	it("should detect interface kind from code", async () => {
		const dg = new DocGenerator();
		const update = await dg.generateDoc("/test.ts", "MyInterface", "interface MyInterface { }");
		expect(update.newDoc).toContain("interface");
	});

	it("should detect variable kind from code", async () => {
		const dg = new DocGenerator();
		const update = await dg.generateDoc("/test.ts", "myVar", "const myVar = 42;");
		expect(update.newDoc).toContain("variable");
	});

	it("should include file path and language in doc", async () => {
		const dg = new DocGenerator();
		const update = await dg.generateDoc("/project/src/app.py", "run", "def run(): pass");
		expect(update.newDoc).toContain("/project/src/app.py");
		expect(update.newDoc).toContain("Python");
	});

	it("should extract existing JSDoc from code", async () => {
		const dg = new DocGenerator();
		const code = "/** Existing doc */\nfunction foo() {}";
		const update = await dg.generateDoc("/test.ts", "foo", code);
		expect(update.oldDoc).toContain("Existing doc");
	});

	it("should return null for non-stale docs", () => {
		const dg = new DocGenerator();
		const result = dg.detectStaleDocs("/test.ts", "function foo() {}", "/** Foo */");
		expect(result).toBeNull();
	});

	it("should detect stale docs when referenced symbol is missing", () => {
		const dg = new DocGenerator();
		const result = dg.detectStaleDocs("/test.ts", "function bar() {}", "/** Uses `foo` internally */");
		expect(result).not.toBeNull();
		expect(result!.reason).toContain("foo");
	});

	it("should provide default config", () => {
		const dg = new DocGenerator();
		const config = dg.getConfig();
		expect(config.enabled).toBe(true);
		expect(config.autoRegenerateJSDoc).toBe(true);
	});

	it("should update config", () => {
		const dg = new DocGenerator();
		dg.updateConfig({ autoRegenerateJSDoc: false });
		expect(dg.getConfig().autoRegenerateJSDoc).toBe(false);
	});
});
