import io

p = 'src/cli.ts'
s = open(p, encoding='utf-8').read()
bad = '  web-kimi    kimi.ai (login required)\n  web-deepseek chat.deepseek.com");'
good = '  web-kimi    kimi.ai (login required)");\n    console.log("  web-deepseek chat.deepseek.com");'
if bad in s:
    s = s.replace(bad, good)
    open(p, 'w', encoding='utf-8').write(s)
    print('cli.ts fixed')
else:
    print('cli.ts: bad pattern not found (already fixed?)')

p = 'src/transport/driver.ts'
s = open(p, encoding='utf-8').read()
bad1 = 'conversationUrl: (id) => https://chat.deepseek.com/a/chat/s/${id},'
good1 = 'conversationUrl: (id) => `https://chat.deepseek.com/a/chat/s/${id}`,'
if bad1 in s:
    s = s.replace(bad1, good1)
    print('driver.ts: backticks restored')
bad2 = '},\nEOF\n    extSite: "glm",'
good2 = '},\n  zai: {\n    id: "zai",\n    extSite: "glm",'
if bad2 in s:
    s = s.replace(bad2, good2)
    print('driver.ts: EOF stray removed, zai header restored')
open(p, 'w', encoding='utf-8').write(s)
print('driver.ts written')
