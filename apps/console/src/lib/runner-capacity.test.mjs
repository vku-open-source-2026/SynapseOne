// SPDX-License-Identifier: Apache-2.0
// SPDX-FileCopyrightText: 2026 VKU.VIC
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {commandWithResources, dockerDefaults, estimateFleet, fleetHistory} from './runner-capacity.mjs';
const now = Math.floor(Date.now()/15000)*15000+7500;
const sample = (time = now) => ({sampledAt: new Date(time).toISOString(), cpu: {limitCores: 2,usedCores: .1,availableCores: 1.9},memory: {limitMb: 1024,usedMb: 128,availableMb: 896}});
const runner = (id = 'one', overrides = {}) => ({id,kind: 'workflow',status:'connected',instances:[{id: id+'-instance',status:'connected',concurrency: 8,metadata:{resources:sample(),activeJobs:{workflow:0,inference:0},resourceHistory:[sample(now-15000),sample()]}}],...overrides});
test('fleet fits each connector before summing slots, excludes missing/stale/future/disabled/inference', () => {
  const stale = runner('stale'); stale.instances[0].metadata.resources = sample(now-45001);
  const future = runner('future'); future.instances[0].metadata.resources = sample(now+5001);
  const missing = runner('missing'); delete missing.instances[0].metadata.resources;
  const fleet = estimateFleet([runner(), runner('two'),stale,future,missing,runner('disabled',{status:'disabled'}),runner('inference',{kind:'inference'})],{},now);
  assert.equal(fleet.fresh,3); assert.equal(fleet.workflowFresh,2); assert.equal(fleet.slots,6); assert.equal(fleet.cpuLimit,6);
});
test('estimate respects concurrency, reservations, headroom, request profile and assumed duration', () => {
  const busy = runner(); busy.instances[0].concurrency = 2; busy.instances[0].metadata.activeJobs = {workflow:1,inference:1};
  const fleet = estimateFleet([busy],{cpu:.5,memoryMb:128,duration:2},now);
  assert.equal(fleet.slots,0); assert.equal(fleet.active,2);
  busy.instances[0].metadata.activeJobs.inference = 0;
  const limited = estimateFleet([busy],{cpu:.5,memoryMb:128,duration:2},now);
  assert.equal(limited.slots,1); assert.equal(limited.rps,.5);
  assert.equal(estimateFleet([runner()],{cpu:8,memoryMb:8192},now).slots,0);
});
test('capacity does not pool fractional fragments on different hosts', () => {
  const list = [runner(),runner('two')];
  for (const r of list) r.instances[0].metadata.resources.cpu.availableCores = .6;
  assert.equal(estimateFleet(list,{cpu:.5},now).slots,0);
});
test('fleet history deduplicates bucket points and omits partial buckets', () => {
  const a = runner(), b = runner('two');
  a.instances[0].metadata.resourceHistory.push(sample(now-1));
  const history = fleetHistory([a,b],5,now);
  assert.equal(history.length,2); assert.equal(history.at(-1).memory.usedMb,256);
  b.instances[0].metadata.resourceHistory.pop();
  assert.equal(fleetHistory([a,b],5,now).length,1);
});
test('Docker resources change only numeric generated flags, preserving quoted opaque values', () => {
  const command = ["docker run -d --cpus=2 --memory=1024m --memory-swap=1024m --name example \\", "  -e SYNAPSEONE_API_KEY='opaque$secret' \\", "  -e LOCAL_INFERENCE_MODEL_EMBEDDINGS='--memory=12m repo' \\", '  -e WORKFLOW_RUNNER_CONCURRENCY=8 \\', '  image@sha256:abcdef'].join('\n');
  const options = {cpuEnabled:false,memoryEnabled:false,cpus:4,memoryMb:4096,concurrency:3};
  const disabled = commandWithResources(command,options);
  assert.equal(disabled.split('\n')[0], 'docker run -d --name example \\');
  assert.ok(disabled.includes("SYNAPSEONE_API_KEY='opaque$secret'"));
  assert.ok(disabled.includes("MODEL_EMBEDDINGS='--memory=12m repo'"));
  assert.ok(disabled.includes('CONCURRENCY=3'));
  const enabled = commandWithResources(disabled,{...options,cpuEnabled:true,memoryEnabled:true});
  assert.ok(enabled.startsWith('docker run -d --cpus=4 --memory=4096m --memory-swap=4096m '));
});
test('workflow defaults and saved disabled limits survive readback', () => {
  assert.equal(dockerDefaults({kind:'workflow'}).memoryMb,1024);
  assert.equal(dockerDefaults({kind:'hybrid'}).memoryMb,6144);
  assert.equal(dockerDefaults({kind:'workflow',dockerResources:{cpuEnabled:false,concurrency:3}}).cpuEnabled,false);
});
