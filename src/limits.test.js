import test from 'node:test';
import assert from 'node:assert/strict';
import { validateFile,validateDimensions,MAX_FILE_BYTES } from './limits.js';
test('1 GiB source and 4K dimensions accepted independently',()=>{
 assert.equal(MAX_FILE_BYTES, 1_073_741_824);
 assert.doesNotThrow(()=>validateFile(1_073_741_824));
 assert.doesNotThrow(()=>validateDimensions(3840,2160));
 assert.doesNotThrow(()=>validateDimensions(4096,4096));
 assert.throws(()=>validateFile(1_073_741_825),/1 GiB/);
 assert.throws(()=>validateDimensions(8192,8192),/1677/);
});
