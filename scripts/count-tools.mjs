#!/usr/bin/env node
import { loadToolCatalog } from './tool-catalog.mjs';

console.log(String(loadToolCatalog().total_tools));
