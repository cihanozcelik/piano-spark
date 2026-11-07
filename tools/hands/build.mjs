import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
const directory=fileURLToPath(new URL('../../assets/hands/',import.meta.url));
await mkdir(directory,{recursive:true});
await build({entryPoints:[fileURLToPath(new URL('./runtime-entry.js',import.meta.url))],outfile:directory+'runtime.js',
  bundle:true,format:'iife',minify:true,legalComments:'linked',target:['safari17','chrome110']});
await copyFile(fileURLToPath(new URL('./node_modules/three/LICENSE',import.meta.url)),directory+'THREE-LICENSE.txt');
console.log('Built the offline Three.js / glTF hand renderer.');
