"""Extract reusable visual presets and local reference covers from a supplied export."""
import collections
import concurrent.futures
import hashlib
import io
import json
import math
from pathlib import Path
import re
import sys
import subprocess
import urllib.request
from PIL import Image, ImageOps

ROOT = Path(__file__).resolve().parents[1]
SOURCE = Path(sys.argv[1])
DATA = json.loads((SOURCE / 'data/skills.json').read_text(encoding='utf-8'))['skills']
OUT = ROOT / 'third-party/styles'
OUT.mkdir(parents=True, exist_ok=True)
PRESETS = []


def file(skill, needle):
    item = next(x for x in DATA if x['name'] == skill)
    asset = next(f for f in item['skillFiles'] if needle in f['path'])
    return asset['content'].replace('\r', ''), item['skillUuid'], asset['path']


def add(name, category, body, origin):
    body = body.strip().strip('-').strip()
    if not body or any(x['name'] == name and x['category'] == category for x in PRESETS):
        return
    PRESETS.append(dict(name=name, category=category, prompt=body, sourceSkillId=origin[0], sourceFile=origin[1]))


for needle in ['10-电影美学风格映射表.md', '10-电影美学风格映射表2.md']:
    content, *origin = file('AI视觉全流程v1.0', needle)
    category = ''
    sections = re.split(r'(?m)^(## (?:题材[^\n]+)|### \d+\.[^\n]+)\n', content)
    for i in range(1, len(sections), 2):
        heading, body = sections[i], sections[i+1]
        if heading.startswith('## '):
            category = heading.split('：', 1)[-1].strip()
        else:
            title = re.search('《([^》]+)》', heading)
            if title:
                # Keep visual attributes only, excluding document usage/routing instructions.
                attrs = re.findall(r'(?m)^- \*\*[^\n]+', body)
                add(title[1] + ' · 电影美学', category, '\n'.join(attrs), origin)

for needle in ['_01_', '_02_']:
    content, *origin = file('「大师镜头」名导风格视觉', needle)
    sections = re.split(r'(?m)^### \d+\. ([^\n]+)\n', content)
    for i in range(1, len(sections), 2):
        add(sections[i].strip()+' · 导演美学', '导演美学', sections[i+1], origin)
content, *origin = file('「大师镜头」名导风格视觉', '_03_')
sections = re.split(r'(?m)^### 🎬 配方 [A-Z]：「([^」]+)」\n', content)
for i in range(1, len(sections), 2):
    add(sections[i]+' · 混搭', '混搭美学', sections[i+1].split('## 三、')[0], origin)

content, *origin = file('短剧全流程系统', '导演风格词库')
for name, keywords in re.findall(r'\| \*\*([^*]+)\*\* \| `([^`]+)` \|', content):
    add(name, '主视觉风格', keywords, origin)
content, *origin = file('真人电影制作', 'style-routing.md')
for line in content.split('### 路由修正规则')[0].splitlines():
    cells = [c.strip() for c in line.strip('|').split('|')]
    if len(cells) == 6 and line.startswith('|') and cells[1] not in ('摄影机推荐', '') and not cells[0].startswith('-'):
        add(cells[0]+' · 实拍', '摄影流派', '；'.join(k+'：'+v for k,v in zip(['题材','摄影机','镜头','胶片色彩','布光','色调'],cells)), origin)
content, *origin = file('一站式生成广告', '品类风格三视图')
content = content.split('## 三、')[1].split('## 四、')[0]
for line in content.splitlines():
    cells = [c.strip().strip('*') for c in line.strip('|').split('|')]
    if line.startswith('| **') and len(cells) == 6:
        add(cells[0]+' · 广告', '广告视觉', '；'.join(cells[1:]), origin)


def tokens(text):
    text = text.lower()
    result = set(re.findall(r'[a-z0-9]{3,}', text))
    for word in re.findall(r'[\u4e00-\u9fff]+', text):
        result.update(word[i:i+2] for i in range(len(word)-1))
    return result


# Select representative reference art from the supplied catalog, not film stills.
candidates = [x for x in DATA if x.get('coverUrl', '').startswith('https://')]
token_sets = [tokens(x['name']+' '+x.get('description','')) for x in candidates]
frequency = collections.Counter(t for ts in token_sets for t in ts)
used = set()
reference_counts = collections.Counter()
HINTS = {}
for group, reference in [
    ('布达佩斯大饭店|月升王国|韦斯·安德森|童话审判|暴力糖果', '韦斯安德森电影美学'),
    ('天使爱美丽|阿甘正传|怦然心动|浪漫/怀旧', '复古35mm胶片温情故事'),
    ('花样年华|重庆森林|甜蜜蜜|春娇与志明|王家卫|港式西部', '王家卫电影美学'),
    ('寄生虫|奉俊昊|阶级剖面|搏击俱乐部', '戈登威利斯暗部摄影'),
    ('霸王别姬|陈凯歌|妖猫传|华丽宫廷', '张艺谋东方美学电影分镜'),
    ('海边的曼彻斯特|侯孝贤|是枝裕和|人物剧情', '是枝裕和电影美学'),
    ('泰坦尼克号|傲慢与偏见|情书|爱在黎明破晓前', '唯美胶片摄影短片'),
    ('禁闭岛|穆赫兰道|消失的爱人|看不见的客人|斯坦利·库布里克', '希区柯克悬疑片'),
    ('记忆碎片|克里斯托弗·诺兰|星际穿越', '诺兰风格IMAX胶片电影'),
    ('疯狂的麦克斯4：狂暴之路|废墟华尔兹', '写实废土赛博朋克'),
    ('疾速追杀|谍影重重3|盗火线|寒战', '昆汀式风格电影美学'),
    ('黑客帝国|银翼杀手2049|沙丘|丹尼斯·维伦纽瓦|潮湿巨物', '维伦纽瓦科幻电影美学'),
    ('功夫|疯狂的石头|甲方乙方', '老港味武侠喜剧短片'),
    ('无间道|洛城机密|门徒', '灰烬之城-年代黑帮剧创作'),
    ('攻壳机动队|赛博朋克', '赛博朋克风格导演'),
    ('阿凡达|奇幻/史诗|指环王：护戒使者', '西欧奇幻异世界'),
    ('青蛇|蜀山传|封神第一部：朝歌风云|狄仁杰之神都龙王', '魔幻仙侠玄幻剧真人质感'),
    ('潘神的迷宫|水形物语|哈利·波特与魔法石', '暗黑奇幻电影短片'),
    ('特洛伊|惊天战神|诸神之战|亚瑟王：斗兽争霸|角斗士|勇敢的心|天国王朝|法老与众神|亚历山大大帝', '神话巨兽美学史诗感'),
    ('闪灵|招魂|咒怨|寂静岭', '悬疑恐怖预告片生成引擎'),
    ('异形：契约', '电影级科幻连续短剧导演'),
    ('阳光灿烂的日子|姜文', '复古35mm胶片温情故事'),
    ('蓝色大门|少年的你|壁花少年', '日系青春电影感视频风格'),
    ('英雄|张艺谋|乡土史诗', '张艺谋东方美学电影分镜'),
    ('卧虎藏龙|东邪西毒|新龙门客栈|剑雨|李安', '胡金铨武侠美学'),
    ('被解救的姜戈|大地惊雷|决战犹马镇|荒野猎人|独行侠', '荒野决斗·西部片导演'),
    ('加勒比海盗：黑珍珠号的诅咒', '西欧奇幻异世界'),
    ('查理和巧克力工厂', '韦斯·安德森复古美学短片'),
    ('辛德勒的名单|1917|至暗时刻|大明劫|决战中途岛|战争/动作', '历史战争剧-丫一吧'),
    ('爱乐之城|迷失东京|杨德昌', '宝岛浪潮电影美学'),
    ('贾樟柯|纪实风格|纪录片/手持', '纪实风格微短片创作'),
    ('水墨赛博', '水墨武侠风格'),
    ('电影感写实', '尼克维斯特柔光摄影'),
    ('唯美梦幻', '唯美胶片摄影短片'),
    ('自然/地理', '卢贝兹基长镜头美学'),
    ('简约极简|极简现代|新品首发', '苹果风产品纯净TVC广告'),
    ('自然清新|北欧温馨|生活方式', '室内空间广告导演'),
    ('厨房实景', '美食诱惑广告'),
    ('日系治愈', '日系小清新/文艺风格短片'),
    ('复古怀旧', '复古胶片广告风导演'),
    ('MG 动画', '一键生成UI交互TVC广告片'),
]:
    for name in group.split('|'):
        HINTS[name] = reference
for preset in PRESETS:
    title_tokens = tokens(preset['name'].split(' · ')[0])
    category_tokens = tokens(preset['category'].replace('类',''))
    text_tokens = tokens(preset['category']+' '+preset['prompt'])
    def score(index):
        ts = token_sets[index]
        name_tokens = tokens(candidates[index]['name'])
        return (min(30, sum(math.log(1+len(candidates)/frequency[t]) for t in ts & text_tokens))
                + 100*len(name_tokens & title_tokens) + 35*len(name_tokens & category_tokens))
    order = sorted(range(len(candidates)), key=score, reverse=True)
    hint = HINTS.get(preset['name'].split(' · ')[0])
    if hint:
        exact = [i for i,x in enumerate(candidates) if x['name'] == hint]
        assert exact, hint
        order = exact + [i for i in order if i not in exact]
    for index in order:
        match = candidates[index]
        options = [c['url'] for c in match.get('caseItems',[]) if re.search(r'\.(png|jpe?g|webp)(\?|$)', c.get('url',''), re.I)] + [match['coverUrl']]
        available = next((url for url in options if url not in used), options[0])
        break
    used.add(available)
    preset['referenceName'] = match['name']
    preset['referenceUrl'] = available
    videos = [c['url'] for c in match.get('caseItems',[]) if re.search(r'\.mp4(\?|$)', c.get('url',''), re.I)]
    if videos:
        occurrence = reference_counts[match['skillUuid']]
        preset['referenceVideo'] = videos[occurrence % len(videos)]
        preset['referenceTime'] = 1 + (occurrence // len(videos)) * 1.7
        reference_counts[match['skillUuid']] += 1

def download(preset):
    url = preset['referenceUrl']
    cache = OUT / 'download-cache'
    cache.mkdir(exist_ok=True)
    cache_key = preset.get('referenceVideo', url)+str(preset.get('referenceTime',''))
    cached = cache / (hashlib.sha256(cache_key.encode()).hexdigest()+'.webp')
    if not cached.exists():
        raw = b''
        if preset.get('referenceVideo'):
            try:
                result = subprocess.run(['ffmpeg','-v','error','-rw_timeout','20000000','-ss',str(preset['referenceTime']),
                    '-i',preset['referenceVideo'],'-frames:v','1','-vf','scale=960:-2','-f','image2pipe','-vcodec','mjpeg','pipe:1'],
                    capture_output=True, timeout=45)
                if result.returncode == 0:
                    raw = result.stdout
            except (subprocess.TimeoutExpired, FileNotFoundError):
                pass
        if not raw:
            request = urllib.request.Request(url, headers={'User-Agent':'Mozilla/5.0'})
            with urllib.request.urlopen(request, timeout=45) as response:
                raw = response.read(20*1024*1024)
        im = ImageOps.exif_transpose(Image.open(io.BytesIO(raw))).convert('RGB')
        im.thumbnail((960, 720))
        if min(im.size) < 80:
            raise ValueError('Reference cover too small: '+preset['name'])
        im.save(cached, 'WEBP', quality=85)
    data = cached.read_bytes()
    digest = hashlib.sha256(data).hexdigest()
    folder = ROOT / 'web/public/styles/covers'
    folder.mkdir(parents=True, exist_ok=True)
    (folder/(digest+'.webp')).write_bytes(data)
    preset['coverUrl'] = '/styles/covers/'+digest+'.webp'
    preset['coverSha256'] = digest
    return preset


with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
    results = list(pool.map(download, PRESETS))

migration = ROOT / 'server/src/main/resources/db/migration/V40__Import_Visual_Styles.sql'
if migration.exists():
    raise SystemExit('Refusing to overwrite existing migration')
sql = ['-- Local visual-style library; generated by scripts/import-style-library.py.',
       'SET LOCAL standard_conforming_strings = on;']
def quote(value):
    return "'"+value.replace("'", "''")+"'"
for preset in results:
    for kind in ['image','video']:
        constraint = ('应用于静态图片，只提取构图、色彩、光影、材质和成像特征，运镜描述转换为单帧构图。' if kind == 'image' else '应用于视频，保持跨镜头色彩、光影、材质与人物外观一致。')
        prompt = '视觉风格参考（不替换用户主体、文字及页面尺寸要求）：\n'+preset['prompt']+'\n'+constraint
        sql.append('INSERT INTO generation_styles(generation_type,name,style_prompt,cover_url,category,status,sort_order) SELECT '+','.join(map(quote,[kind,preset['name'],prompt,preset['coverUrl'],preset['category']]))+',1,1000 WHERE NOT EXISTS (SELECT 1 FROM generation_styles WHERE name='+quote(preset['name'])+' AND generation_type='+quote(kind)+');')
migration.write_text('\n'.join(sql)+'\n',encoding='utf-8',newline='\n')
(OUT/'catalog.json').write_text(json.dumps(results,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({'presets':len(results),'databaseRows':2*len(results),'categories':dict(collections.Counter(x['category'] for x in results))},ensure_ascii=False))
