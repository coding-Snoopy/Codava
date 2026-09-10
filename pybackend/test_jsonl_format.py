"""
测试 JSONL 文件格式检测
"""

import json
from pathlib import Path

def detect_file_format(json_file_path: str) -> str:
    """检测 JSON 文件的格式"""
    with open(json_file_path, 'r', encoding='utf-8') as f:
        first_line = f.readline().strip()
        
        if not first_line:
            return 'unknown'
        
        if first_line.startswith('[') or first_line.startswith('{'):
            try:
                json.loads(first_line)
                second_line = f.readline().strip()
                if second_line:
                    return 'jsonl'
                else:
                    return 'json'
            except json.JSONDecodeError:
                return 'json'
        
        try:
            json.loads(first_line)
            return 'jsonl'
        except json.JSONDecodeError:
            return 'unknown'

# 测试不同的文件
test_files = [
    "data/refactor_history_sample.jsonl",
    "data/refactor_history_sample.json"
]

for file_path in test_files:
    path = Path(__file__).parent / file_path
    if path.exists():
        format_type = detect_file_format(str(path))
        print(f"{file_path}: {format_type.upper()}")
        
        # 显示前几行
        with open(path, 'r', encoding='utf-8') as f:
            print(f"  前 3 行预览:")
            for i, line in enumerate(f, 1):
                if i > 3:
                    break
                print(f"  [{i}] {line.strip()[:80]}...")
    else:
        print(f"{file_path}: 文件不存在")
