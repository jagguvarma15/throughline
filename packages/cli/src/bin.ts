#!/usr/bin/env node
import { runCli } from "./index";

process.exitCode = await runCli(process.argv.slice(2));
