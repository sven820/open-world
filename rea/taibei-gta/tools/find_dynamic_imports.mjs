const fs = require('fs');
const dir = 'C:/Users/jinxiaofei/Desktop/open-world/rea/taibei-gta/target_assets/';
for (const f of fs.readdirSync(dir)) {
  if (!f.endsWith('.js')) continue;
  const s = fs.readFileSync(dir + f, 'utf8');
  const re = /import\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
  let m;
  while ((m = re.exec(s))) console.log(f, '->', m[1]);
}
