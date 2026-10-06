import type { Field } from "../src/server/spec";

// A field with the boilerplate filled in, for tests that only care about a
// few properties.
export function field(over: Partial<Field> & Pick<Field, "name" | "type">): Field {
	return { description: over.name, selector: `#${over.name}`, ...over };
}
