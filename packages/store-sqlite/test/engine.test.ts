import { defineEngineSuite } from "@throughline/testing";
import { sqlite } from "../src/index";

// Run the shared engine semantics suite against an in-memory SQLite store.
defineEngineSuite(() => sqlite(":memory:"));
