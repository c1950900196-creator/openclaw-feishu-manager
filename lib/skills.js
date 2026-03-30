const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { SKILLS_DIR, WORKSPACE_SKILLS_DIR } = require('./config');

function scanSkillDir(baseDir, skills, source) {
  try {
    const dirs = fs.readdirSync(baseDir).filter((d) => {
      const p = path.join(baseDir, d);
      return fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, 'SKILL.md'));
    });
    for (const dir of dirs) {
      if (skills.some((s) => s.id === dir)) continue;
      const skillPath = path.join(baseDir, dir, 'SKILL.md');
      const raw = fs.readFileSync(skillPath, 'utf8');
      const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
      let name = dir;
      let description = '';
      let emoji = '';
      if (fmMatch) {
        const fm = fmMatch[1];
        const nameM = fm.match(/^name:\s*(.+)$/m);
        if (nameM) name = nameM[1].trim();
        const descM = fm.match(/^description:\s*['"]?(.+?)['"]?$/m);
        if (descM) description = descM[1].trim().substring(0, 200);
        const emojiM = fm.match(/"emoji":\s*"([^"]+)"/);
        if (emojiM) emoji = emojiM[1];
      }
      const stat = fs.statSync(skillPath);
      const allFiles = [];
      function walk(d, rel) {
        for (const f of fs.readdirSync(d)) {
          const full = path.join(d, f);
          const r = rel ? rel + '/' + f : f;
          if (fs.statSync(full).isDirectory()) walk(full, r);
          else allFiles.push({ name: r, size: fs.statSync(full).size });
        }
      }
      walk(path.join(baseDir, dir), '');
      const files = [];
      const subdirs = {};
      for (const f of allFiles) {
        const slashIdx = f.name.indexOf('/');
        if (slashIdx < 0) files.push(f);
        else {
          const dirName = f.name.substring(0, slashIdx);
          if (!subdirs[dirName]) subdirs[dirName] = { count: 0, size: 0 };
          subdirs[dirName].count++;
          subdirs[dirName].size += f.size;
        }
      }
      for (const [dn, info] of Object.entries(subdirs)) {
        files.push({ name: dn + '/', size: info.size, isDir: true, fileCount: info.count });
      }
      skills.push({
        id: dir,
        name,
        emoji,
        description,
        files,
        totalFiles: allFiles.length,
        modified: stat.mtime.toISOString(),
        source,
        _baseDir: baseDir,
      });
    }
  } catch (e) {
    console.error('scanSkillDir error (' + source + '):', e.message);
  }
}

function listSkills() {
  const skills = [];
  scanSkillDir(WORKSPACE_SKILLS_DIR, skills, 'workspace');
  scanSkillDir(SKILLS_DIR, skills, 'builtin');
  return skills.sort((a, b) => a.name.localeCompare(b.name));
}

function packageSkill(skillDir) {
  let skillPath = path.join(WORKSPACE_SKILLS_DIR, skillDir);
  if (!fs.existsSync(path.join(skillPath, 'SKILL.md'))) skillPath = path.join(SKILLS_DIR, skillDir);
  if (!fs.existsSync(path.join(skillPath, 'SKILL.md'))) return null;
  const outPath = path.join('/tmp', skillDir + '.skill');
  try {
    execSync(`cd "${path.dirname(skillPath)}" && zip -r "${outPath}" "${skillDir}/"`, { timeout: 10000 });
    return outPath;
  } catch {
    return null;
  }
}

module.exports = { listSkills, packageSkill };
