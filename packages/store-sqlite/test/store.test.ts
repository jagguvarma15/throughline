import { defineStoreSuite } from "@through-line/testing";
import { sqlite } from "../src/index";

// Run the shared store conformance battery against an in-memory SQLite store.
defineStoreSuite(() => sqlite(":memory:"));
