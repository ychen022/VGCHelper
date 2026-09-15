import {cpSync,mkdirSync} from 'node:fs';
mkdirSync(new URL('../dist/battle/web/',import.meta.url),{recursive:true});
cpSync(new URL('../src/battle/web/',import.meta.url),new URL('../dist/battle/web/',import.meta.url),{recursive:true});
