const fs=require("fs");const b=fs.readFileSync("Mewgenics.exe");const BS=String.fromCharCode(92);
const out=[];let start=-1;for(let i=0;i<b.length;i++){const c=b[i];const pr=c>=32&&c<127;if(pr&&start<0)start=i;if(!pr&&start>=0){if(i-start>=4)out.push([start,b.toString("latin1",start,i)]);start=-1;}}
fs.writeFileSync(process.env.OUT+"/mewgenics/exe-strings.txt",out.map(([o,s])=>o.toString(16)+"\t"+s).join("\n"));
const ctx=(needle,before=12,after=12)=>{const idx=out.findIndex(([o,s])=>s.includes(needle));if(idx<0){console.log("\n## "+needle+": NOT FOUND");return;}console.log("\n## context around \""+needle+"\" @0x"+out[idx][0].toString(16));console.log(out.slice(Math.max(0,idx-before),idx+after).map(([o,s])=>"  "+s.slice(0,120)).join("\n"))};
ctx("Mod Path: ",15,15);ctx("enable_debugconsole",10,10);ctx("dev_mode",8,8);ctx("STEAMUGC_INTERFACE_VERSION021",6,6);ctx("campaign01.sav",8,8);
console.log("\n## flag/config-looking strings:");
console.log([...new Set(out.map(x=>x[1]).filter(s=>/^-{1,2}[a-z][a-z_-]{2,}$/i.test(s)||(/^[a-z_]{4,30}$/.test(s)&&/(console|debug|mod|cheat|skip|fullscreen|vsync|resolution|seed|unlock|dev|godmode|noclip|workshop|steam)/.test(s))))].slice(0,80).join("  "));
console.log("\n## source file paths (code layout):");
const src=[...new Set(out.map(x=>x[1]).filter(s=>s.includes("SVN"+BS+"Mewgenics"+BS)||s.includes("SVN"+BS+"Engine"+BS)))];console.log(src.length);console.log(src.slice(0,80).join("\n"));
const cls=new Set();for(const [,s] of out){const m=s.match(/^\.\?AV([A-Za-z_][A-Za-z0-9_]*)@glaiel@@$/);if(m)cls.add(m[1]);}
const cls2=new Set();for(const [,s] of out){const m=s.match(/^\.\?AV([A-Za-z_][A-Za-z0-9_]*)@@$/);if(m)cls2.add(m[1]);}
console.log("\n## RTTI classes in glaiel namespace:",cls.size);console.log([...cls].sort().join(", "));
console.log("\n## RTTI classes in global namespace:",cls2.size);console.log([...cls2].sort().join(", ").slice(0,6000));
fs.writeFileSync(process.env.OUT+"/mewgenics/rtti-classes.txt",[...cls].sort().map(c=>"glaiel::"+c).concat([...cls2].sort()).join("\n"));
