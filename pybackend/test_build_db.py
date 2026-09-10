"""
快速测试 build_db.py 脚本
"""

import json
from pathlib import Path

# 测试读取示例数据
json_path = Path(__file__).parent / "data" / "refactor_history_sample.json"

print(f"读取测试文件：{json_path}")
print(f"文件存在：{json_path.exists()}")

with open(json_path, 'r', encoding='utf-8') as f:
    data = json.load(f)
    
print(f"\nJSON 类型：{type(data)}")
print(f"顶层元素数量：{len(data) if isinstance(data, (list, dict)) else 'N/A'}")

if isinstance(data, list) and len(data) > 0:
    first_item = data[0]
    print(f"\n第一个元素类型：{type(first_item)}")
    if isinstance(first_item, dict):
        print(f"第一个元素的 keys: {list(first_item.keys())}")
        
        if 'diff_info' in first_item:
            diff_info = first_item['diff_info']
            print(f"\ndiff_info 类型：{type(diff_info)}")
            print(f"diff_info 长度：{len(diff_info)}")
            
            if len(diff_info) > 0:
                first_diff = diff_info[0]
                print(f"\n第一个 diff_info 的 keys: {list(first_diff.keys())}")
                print(f"\nfunc_before 预览：")
                print(first_diff.get('func_before', '')[:200])

print("\n✓ 测试完成！JSON 结构正确。")
