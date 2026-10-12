# 13｜Excel 与 ERP 输出

## 输入工作簿

excel_source_adapter.mjs分析工作簿buffer、判断自有产品来源字段、规范化行并保留source file/hash与cell reference。导入前需要限定Product ID/SKU范围，避免整本导入误带其他SKU。

## Listing输出链

业务步骤完成后，Excel写入应使用原始模板的隔离副本，按正式SOP映射字段，随后重新读取文件执行FILE_QA。应分别验证：

1. 文件可打开、sheet和header结构正确。
2. 目标SKU/EAN与文件一致。
3. 标题、锚点、描述、包装、属性都与正式artifact完全一致。
4. 字符数/字段长度符合固定合同。
5. 公式、单元格类型、隐藏字段及链接没有被错误覆盖。
6. 缺失Facts和UNKNOWN没有被补猜。
7. 导出文件路径仅在acceptance dataRoot和SKU范围内。

## ERP与上传边界

代码中的release gates列有Excel write/readback、await-upload和archive。公开快照没有提供可验证的完整马帮ERP生产提交协议，不能声称ERP正式联通。内容PASS、Excel FILE_QA PASS、ERP提交、平台上传/发布是分离动作。

本公开仓库没有模板Excel，原因是模板再分发许可和业务数据风险未确认。

## 视觉核验

文件能被Excel解析不等于渲染质量通过。若需求要求视觉检查，需要使用真实Excel/WPS或文档渲染器查看页面分页、换行、行高、列宽、字符截断和中荷文对照；工具未运行时报告VISUAL_NOT_RUN。
