const fs = require('fs');

const src = fs.readFileSync('src/index.ts', 'utf8');
const initSrc = fs.readFileSync('../init/index.js', 'utf8');
const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));

let pass = 0, fail = 0;
function check(name, cond) {
  if (cond) { console.log('PASS:', name); pass++; }
  else { console.log('FAIL:', name); fail++; }
}

check('Test 1 - Ambient git learning in session_end', src.includes('git log --since') || src.includes('Ambient git'));
check('Test 2a - author param in learn_from_attempts schema', src.includes('"author"') && src.includes('learn_from_attempts'));
check('Test 2b - Team Telepathy in session_start', src.includes('Team Telepathy') || src.includes('team telepathy'));
check('Test 3 - memory_crystalize tool', src.includes('memory_crystalize'));
check('Test 4 - init team detection (~/.cachly-teams.json)', initSrc.includes('cachly-teams.json'));
check('Test 5 - brain_doctor workspace_path param', src.includes('workspace_path') && src.includes('brain_doctor'));
check('Bugfix - Pre-Warning uses splice(2,0)', src.includes('splice(2, 0'));
check('Bugfix - No broken unshift in pre-warning', !src.includes('lines.unshift('));
check('MCP version is 0.5.26', pkg.version === '0.5.26');

console.log(`\n${pass}/${pass+fail} tests passed`);
