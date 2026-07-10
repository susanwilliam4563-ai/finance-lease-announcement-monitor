# 融资租赁公告看板数据契约

看板支持导入 JSON 文件。JSON 可以是数组，也可以是包含 `records` 或 `rows` 字段的对象。

## 推荐字段

```json
{
  "id": "source:source_id_or_hash",
  "subject_name": "主体名称",
  "subject_type": "A股上市公司|发债主体|子公司/关联方|待识别",
  "stock_code": "证券代码",
  "bond_code": "债券代码",
  "region": "地区",
  "industry": "行业",
  "announcement_date": "YYYY-MM-DD",
  "title": "公告标题",
  "source": "巨潮资讯|交易所|公司官网|预警通|互联网搜索",
  "source_class": "官方公告|发债披露|公司官网|预警通|互联网/公众号|其他来源",
  "source_reliability": "高|中高|中|线索|待复核",
  "source_url": "公告页面链接",
  "pdf_url": "PDF链接",
  "matched_keywords": ["融资租赁", "售后回租"],
  "matched_position": "标题|正文|标题+正文|元数据|待复核",
  "announcement_type": "售后回租|担保公告|关联交易|融资租赁交易|其他",
  "lease_role": "承租人|出租人|担保方|交易对手|未披露",
  "amount": "金额",
  "term": "期限",
  "counterparty": "交易对手",
  "leased_asset": "租赁物",
  "related_party": "是|否|疑似|未披露",
  "guarantee_or_collateral": "担保/抵押",
  "summary": "摘要",
  "risk_labels": ["售后回租", "关联交易", "对外担保"],
  "review_status": "已复核官方公告|已复核预警通|仅二级来源|待补充正文|链接不可打开",
  "snippets": ["命中片段"],
  "attention_level": "A|B|C|D",
  "notes": "备注"
}
```

`source_class` 和 `source_reliability` 可以省略，网页会根据 `source` 自动推断。公众号、新闻稿、搜索结果等非官方内容应标为 `互联网/公众号`，并把 `review_status` 设为 `待复核`。

## 关注等级建议

- A：大额融资、售后回租、关联交易、担保/抵押、连续融资等多项同时出现。
- B：明确融资租赁交易，金额较大或信息披露不完整。
- C：普通融资租赁进展或留档事项。
- D：仅财报披露、弱线索或暂不重要事项。

## 后续接入点

- 巨潮/交易所抓取脚本输出 JSON 后，可直接导入本看板。
- 预警通页面人工导出的数据应映射到同一数据契约。
- 主体关系库应补充 `region`、`industry`、`subject_type`、`stock_code`、`bond_code`。
