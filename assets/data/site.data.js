/* 内容数据 —— 站点配置、《关于》正文、五个场的定义、地标坐标
 * 编辑时只需修改下方花括号 { } 内的内容，语法与 JSON 完全一致。
 * 不要修改第一行和最后一行。改完保存，浏览器按 Ctrl+F5 刷新即可。
 * 详细操作见 docs/07-内容填充指南.md
 *
 * 【v2.0】站名改为「坐标之外 / Layers of Life」，三个场扩展为五个场。
 *        地形高度由每个场的作品数与印记数决定 —— 详见 docs/08 号文档。 */
window.SITE_DATA = {
  "meta": {
    "title": "坐标之外",
    "titleEn": "Layers of Life",
    "author": "枕套"
  },
  "hero": {
    "headline": "坐标之外",
    "headlineEn": "Layers of Life"
  },
  "messages": {
    "emptyWorks": "这一片场还没有作品。",
    "emptyNotes": "这一片场还没有留下印记。",
    "emptyNotesAll": "还没有留下任何印记。",
    "errorData": "内容数据没能加载。请检查 assets/data/ 下的 .data.js 文件是否被改动过，详见 docs/07-内容填充指南.md。",
    "placeholderTag": "待补",
    "loadFailed": "页面没能正常启动，请用较新版本的 Chrome / Edge / Safari / Firefox 打开。"
  },
  "about": {
    "title": "关于",
    "paragraphs": [
      "我读的是地理空间信息工程。这个名字听着离生活很远，说穿了就是把地面上的东西搬进坐标系。大二做土地利用作业，我把同一片地十年的三期影像叠在一起，眼看着一口水塘变成了厂房。屏幕上只有几厘米，里面装着十年。",
      "另一双眼睛用来看街。和朋友出门，我常常是负责拍照的那个，但我更爱拍那些没人会停下来的角落：被雨泡软的旧招牌、窗台上三个并排的塑料瓶、一只蹲在电动车座上打哈欠的猫。这些画面小得不值一提，可它们是一天里唯一没有排练过的部分。",
      "耳朵这边是琴。吉他、尤克里里、一台二手小键盘，都弹得不算好，但练琴是我一天里最安静的一段。真正让我坐得住的不是旋律，是节拍器：它不评价你，只告诉你刚才那一下早了半拍。我在它面前比想象中耐心得多。",
      "灶上是另一回事。我喜欢做别人没吃过的搭配，不是因为胆子大，是因为食材自己会说话——同一把青菜，早下锅十秒和后下锅十秒是两个味道，你得尝了才知道它现在到哪儿了。做完端上桌的那一下，和我把图跑完看到结果的那一下，是同一种感觉。",
      "球场是第五块地方。棒垒球里我最在意守备，因为球还没被打出来，你就得先动。垒上有人该往哪传，打者是拉打还是推打，这些都得在球离棒之前想完。我守外野的时候总慢半步，后来才慢慢明白，站位不是一个点，是提前站到球会去的地方。",
      "这五件事看着互不相干，做到最后却是同一个动作：先看清楚，再动手做出来。地图是看清一块地的十年，照片是看清一个没人在意的瞬间，节拍器是听清自己早了半拍，灶上是看清食材此刻的状态，守备是看清球会往哪去。看清楚已经不容易，做出来更难。我大概会一直练这两件事。"
    ]
  },
  "fields": [
    {
      "id": "space",
      "landmark": "A",
      "name": "空间",
      "nameEn": "SPACE",
      "subtitle": "城市空间信息工程 · 课程、实习与科研",
      "sense": "空间感 · 俯视之眼",
      "color": "#3F4A35",
      "colorLight": "#BFCBA8",
      "colorDark": "#333D28",
      "position": { "x": 0.16, "y": 0.28 },
      "metaphor": "contour",
      "intro": ""
    },
    {
      "id": "light",
      "landmark": "B",
      "name": "光影",
      "nameEn": "LIGHT",
      "subtitle": "摄影",
      "sense": "视觉 · 平视之眼",
      "color": "#3F4A35",
      "colorLight": "#BFCBA8",
      "colorDark": "#333D28",
      "position": { "x": 0.74, "y": 0.16 },
      "metaphor": "aperture",
      "intro": "拍那些没人会停下来的角落。"
    },
    {
      "id": "rhythm",
      "landmark": "C",
      "name": "节奏",
      "nameEn": "RHYTHM",
      "subtitle": "音乐创作",
      "sense": "听觉",
      "color": "#3F4A35",
      "colorLight": "#BFCBA8",
      "colorDark": "#333D28",
      "position": { "x": 0.82, "y": 0.56 },
      "metaphor": "wave",
      "intro": "旋律、词句，还有它们组成的故事。"
    },
    {
      "id": "taste",
      "landmark": "D",
      "name": "味道",
      "nameEn": "TASTE",
      "subtitle": "手工料理",
      "sense": "味觉 · 嗅觉",
      "color": "#3F4A35",
      "colorLight": "#BFCBA8",
      "colorDark": "#333D28",
      "position": { "x": 0.52, "y": 0.82 },
      "metaphor": "swirl",
      "intro": "食材自己会说话，你得尝了才知道它现在到哪儿了。"
    },
    {
      "id": "field",
      "landmark": "E",
      "name": "场",
      "nameEn": "FIELD",
      "subtitle": "棒垒球",
      "sense": "体感 · 触觉",
      "color": "#3F4A35",
      "colorLight": "#BFCBA8",
      "colorDark": "#333D28",
      "position": { "x": 0.14, "y": 0.68 },
      "metaphor": "sector",
      "intro": "球还没到，先站到它要去的地方。"
    }
  ],

  "environment": {
    "_说明": "环境层不调用外部服务。太阳位置由经纬度和设备时间计算；mood/weather 预留给后续数据源。",
    "location": {
      "label": "西安",
      "latitude": 34.2667,
      "longitude": 108.9333,
      "timezoneOffsetMinutes": 480
    },
    "sun": {
      "nightElevation": 7,
      "nightIntensity": 0.18
    },
    "ambientTerrain": {
      "enabled": true,
      "driver": "time",
      "seed": 20261002,
      "relief": 0.30,
      "contourInterval": 0.02,
      "combinedContourInterval": 0.025,
      "combinedGridSize": 512,
      "gridSize": 160,
      "ridgeCount": 24,
      "cycleFrames": 16,
      "periodMinutes": 0.4,
      "changeTolerance": 0.025,
      "breathe": 0.18,
      "drift": 0.018,
      "warp": 0.42,
      "mood": 0.5,
      "weather": 0.5,
      "extent": { "x0": -2.2, "y0": -2.2, "x1": 3.2, "y1": 3.2 }
    }
  },

  "terrain": {
    "_说明": "地形生长机制的参数。改这里会改变整张地图的形状，建议先看 docs/08 号文档再动。",
    "weightWork": 1.0,
    "weightNote": 0.35,
    "reference": 10,
    "sigma": 0.12,
    "breadthBase": 0.75,
    "breadthGrowth": 0.28,
    "contourInterval": 0.05,
    "tilt": 52,
    "verticalExaggeration": 0.55,
    "gridSize": 160,
    "_noise说明": "湍流噪声参数。乘性施加，保证空白区严格保持 0。种子固定，同一份数据永远得到同一张地图。频率受网格分辨率约束，改 gridSize 时要一起复核。",
    "noiseAmp": 0.18,
    "noiseFreq": 11,
    "noiseOctaves": 3,
    "noiseLac": 2.0,
    "noiseGain": 0.5,
    "noiseSeed": 20261001
  }
};
