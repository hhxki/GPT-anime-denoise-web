import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFile,validateDimensions,MAX_FILE_BYTES } from './limits.js';
test('10 MiB source and 4K dimensions accepted independently',()=>{
 assert.doesNotThrow(()=>validateFile(MAX_FILE_BYTES));
 assert.doesNotThrow(()=>validateDimensions(3840,2160));
 assert.doesNotThrow(()=>validateDimensions(4096,4096));
 assert.throws(()=>validateFile(MAX_FILE_BYTES+1),/10 MB/);
 assert.throws(()=>validateDimensions(8192,8192),/1677/);
});
