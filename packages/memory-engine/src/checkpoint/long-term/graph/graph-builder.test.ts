import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildStoredMemory } from './graph-builder.js';

test('structured revision fields preserve punctuation and normalize aliases', () => {
  const claim = {kind:'decision' as const,subject:'Postgres',predicate:'base_url',value:'https://api.example.com/v1.5',confidence:0.9,sourceMessageIds:[],files:[]};
  const memory = buildStoredMemory(claim,{operation:'ADD',semanticKey:'postgresql::base url'},{workspaceId:'w1',sessionId:'s1',evidenceEventIds:[]});
  assert.equal(memory.semanticKey,'postgresql::base url');
  assert.equal(memory.value,claim.value);
});
