"""
从大型 JSON 文件初始化 SQLite 数据库的脚本。
读取历史重构数据，使用 CodeBERT 提取特征向量，并存入 SQLite 数据库。

JSON 文件结构说明：
- 顶层是一个数组（或包含数组的字典）
- 每个元素包含：
  - file_path: 代码文件路径
  - diff_info: 数组，包含多个函数的重构信息
    - func_before: 函数修改前的代码
    - func_after: 函数修改后的代码
    - func_diff: diff 文本（忽略）
    - class_before: 类修改前的名称
    - class_after: 类修改后的名称

依赖安装：
    pip install transformers torch numpy sqlite3

使用方法：
    python build_db.py [json_file_path] [db_output_path] [num_records]
    
示例：
    python build_db.py data/refactor_history.json data/refactor_rag.db 100
"""

import sys
import io

# 设置标准输出为 UTF-8 编码（修复 Windows 终端中文乱码）
if sys.platform == 'win32':
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

import json
import sqlite3
import numpy as np
from pathlib import Path
from typing import Generator, Dict, Any, List, Optional
from transformers import AutoTokenizer, AutoModel
import torch


def load_codebert_model():
    """加载 CodeBERT 模型和分词器"""
    print("正在加载 CodeBERT 模型...")
    tokenizer = AutoTokenizer.from_pretrained("microsoft/codebert-base")
    model = AutoModel.from_pretrained("microsoft/codebert-base")
    model.eval()
    print("CodeBERT 模型加载完成")
    return tokenizer, model


def extract_code_vector(code: str, tokenizer, model) -> np.ndarray:
    """
    使用 CodeBERT 提取代码的特征向量
    返回一维浮点数组（CLS token 的 embedding）
    """
    inputs = tokenizer(code, return_tensors="pt", truncation=True, max_length=512, padding=True)
    
    with torch.no_grad():
        outputs = model(**inputs)
    
    cls_vector = outputs.last_hidden_state[:, 0, :].squeeze().numpy()
    return cls_vector


def vector_to_json_string(vector: np.ndarray) -> str:
    """将向量数组转换为 JSON 字符串"""
    return json.dumps(vector.tolist())


def json_string_to_vector(json_str: str) -> np.ndarray:
    """将 JSON 字符串转换回向量数组"""
    return np.array(json.loads(json_str))


def create_database(db_path: str):
    """创建 SQLite 数据库和表"""
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()
    
    # 如果表已存在，先删除（覆盖模式）
    cursor.execute('DROP TABLE IF EXISTS refactor_examples')
    
    cursor.execute('''
        CREATE TABLE refactor_examples (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            file_path TEXT,
            before_class_name TEXT,
            after_class_name TEXT,
            before_code TEXT NOT NULL,
            after_code TEXT NOT NULL,
            before_code_vector TEXT NOT NULL
        )
    ''')
    
    # 创建索引以加速查询
    cursor.execute('CREATE INDEX idx_file_path ON refactor_examples(file_path)')
    
    conn.commit()
    return conn


def insert_example(conn, file_path: str, before_class_name: str, after_class_name: str,
                   before_code: str, after_code: str, before_code_vector: str):
    """向数据库插入一条重构示例记录"""
    cursor = conn.cursor()
    cursor.execute('''
        INSERT INTO refactor_examples 
        (file_path, before_class_name, after_class_name, before_code, after_code, before_code_vector)
        VALUES (?, ?, ?, ?, ?, ?)
    ''', (file_path, before_class_name, after_class_name, before_code, after_code, before_code_vector))
    conn.commit()


def detect_file_format(json_file_path: str) -> str:
    """
    检测 JSON 文件的格式
    
    Returns:
        'jsonl' - JSON Lines 格式（每行一个 JSON 对象）
        'json' - 标准 JSON 格式（数组或字典）
        'unknown' - 未知格式
    """
    with open(json_file_path, 'r', encoding='utf-8') as f:
        # 读取第一行
        first_line = f.readline().strip()
        
        if not first_line:
            return 'unknown'
        
        # 如果第一行以 [ 或 { 开头并包含换行符，可能是标准 JSON
        if first_line.startswith('[') or first_line.startswith('{'):
            # 尝试解析第一行，如果失败则可能是标准 JSON 的一部分
            try:
                json.loads(first_line)
                # 解析成功，检查是否还有更多内容
                second_line = f.readline().strip()
                if second_line:
                    # 有多行且每行都是独立的 JSON，则是 JSONL
                    return 'jsonl'
                else:
                    # 只有一行，可能是单行 JSON
                    return 'json'
            except json.JSONDecodeError:
                # 第一行不是完整的 JSON，可能是标准 JSON 的一部分
                return 'json'
        
        # 尝试解析第一行为 JSON
        try:
            json.loads(first_line)
            return 'jsonl'
        except json.JSONDecodeError:
            return 'unknown'


def extract_valid_records(json_file_path: str, max_records: int = 100) -> Generator[Dict[str, str], None, None]:
    """
    内存友好地从 JSON 文件中提取有效的重构记录。
    
    支持三种格式：
    1. JSONL 格式（每行一个 JSON 对象）：{"file_path": "...", "diff_info": [...]}
    2. 标准 JSON 数组：[{file_path, diff_info: [...]}, ...]
    3. 标准 JSON 字典：{"key": {file_path, diff_info: [...]}, ...}
    
    Args:
        json_file_path: JSON 文件路径
        max_records: 最大提取记录数
        
    Yields:
        包含重构记录的字典
    """
    count = 0
    
    print(f"开始读取 JSON 文件：{json_file_path}")
    
    # 检测文件格式
    file_format = detect_file_format(json_file_path)
    print(f"检测到文件格式：{file_format.upper()}")
    
    if file_format == 'jsonl':
        # JSONL 格式处理 - 逐行读取，内存友好
        print("使用 JSONL 格式解析（逐行读取）...")
        
        with open(json_file_path, 'r', encoding='utf-8') as f:
            for line_num, line in enumerate(f, 1):
                if count >= max_records:
                    print(f"已达到目标记录数 {max_records}，停止读取")
                    break
                
                line = line.strip()
                if not line:
                    continue
                
                try:
                    item = json.loads(line)
                except json.JSONDecodeError as e:
                    print(f"警告：第 {line_num} 行 JSON 解析失败：{e}")
                    continue
                
                if not isinstance(item, dict):
                    continue
                
                # 提取 file_path
                file_path = item.get('file_path', '')
                
                # 提取 diff_info 数组
                diff_info_list = item.get('diff_info', [])
                
                if not isinstance(diff_info_list, list):
                    continue
                
                # 遍历 diff_info 中的每个函数记录
                for diff_info in diff_info_list:
                    if count >= max_records:
                        print(f"已达到目标记录数 {max_records}，停止读取")
                        break
                    
                    if not isinstance(diff_info, dict):
                        continue
                    
                    # 提取字段（带默认值）
                    func_before = diff_info.get('func_before', '')
                    func_after = diff_info.get('func_after', '')
                    class_before = diff_info.get('class_before', '')
                    class_after = diff_info.get('class_after', '')
                    
                    # 验证有效性：func_before 和 func_after 都不能为空
                    if not func_before or not func_after:
                        continue
                    
                    # 生成有效记录
                    yield {
                        'file_path': file_path,
                        'before_class_name': class_before,
                        'after_class_name': class_after,
                        'func_before': func_before,
                        'func_after': func_after
                    }
                    
                    count += 1
                    
    elif file_format == 'json':
        # 标准 JSON 格式处理
        print("使用标准 JSON 格式解析...")
        
        with open(json_file_path, 'r', encoding='utf-8') as f:
            # 加载整个 JSON 文件
            data = json.load(f)
            
            # 确定顶层是数组还是字典
            if isinstance(data, list):
                items = data
            elif isinstance(data, dict):
                # 如果是字典，提取所有 value
                items = data.values()
            else:
                raise ValueError("JSON 文件顶层必须是数组或字典")
            
            print(f"开始遍历 {len(items)} 个顶层对象...")
            
            # 遍历顶层对象
            for item in items:
                if count >= max_records:
                    print(f"已达到目标记录数 {max_records}，停止读取")
                    break
                
                if not isinstance(item, dict):
                    continue
                
                # 提取 file_path
                file_path = item.get('file_path', '')
                
                # 提取 diff_info 数组
                diff_info_list = item.get('diff_info', [])
                
                if not isinstance(diff_info_list, list):
                    continue
                
                # 遍历 diff_info 中的每个函数记录
                for diff_info in diff_info_list:
                    if count >= max_records:
                        print(f"已达到目标记录数 {max_records}，停止读取")
                        break
                    
                    if not isinstance(diff_info, dict):
                        continue
                    
                    # 提取字段（带默认值）
                    func_before = diff_info.get('func_before', '')
                    func_after = diff_info.get('func_after', '')
                    class_before = diff_info.get('class_before', '')
                    class_after = diff_info.get('class_after', '')
                    
                    # 验证有效性：func_before 和 func_after 都不能为空
                    if not func_before or not func_after:
                        continue
                    
                    # 生成有效记录
                    yield {
                        'file_path': file_path,
                        'before_class_name': class_before,
                        'after_class_name': class_after,
                        'func_before': func_before,
                        'func_after': func_after
                    }
                    
                    count += 1
    else:
        raise ValueError(f"无法识别的文件格式：{file_format}")
    
    print(f"共找到 {count} 条有效记录")


def build_database(json_file_path: str, db_path: str, num_records: int = 100):
    """
    主函数：从 JSON 文件构建数据库
    
    Args:
        json_file_path: JSON 数据文件路径
        db_path: SQLite 数据库输出路径
        num_records: 要处理的记录数量（默认 100 条）
    """
    print(f"开始从 {json_file_path} 构建数据库...")
    print(f"目标记录数：{num_records} 条")
    print(f"数据库路径：{db_path}")
    
    # 加载模型
    tokenizer, model = load_codebert_model()
    
    # 创建数据库
    conn = create_database(db_path)
    
    processed_count = 0
    error_count = 0
    
    try:
        # 使用生成器逐个提取有效记录
        for record in extract_valid_records(json_file_path, max_records=num_records):
            try:
                func_before = record['func_before']
                func_after = record['func_after']
                file_path = record['file_path']
                class_before = record['before_class_name']
                class_after = record['after_class_name']
                
                # 计算特征向量
                vector = extract_code_vector(func_before, tokenizer, model)
                vector_json = vector_to_json_string(vector)
                
                # 插入数据库
                insert_example(
                    conn,
                    file_path,
                    class_before,
                    class_after,
                    func_before,
                    func_after,
                    vector_json
                )
                
                processed_count += 1
                
                # 进度报告
                if processed_count % 10 == 0:
                    print(f"已处理 {processed_count}/{num_records} 条记录...")
                
                # 达到目标数量后立即停止
                if processed_count >= num_records:
                    break
                    
            except Exception as e:
                print(f"处理记录时出错：{e}")
                error_count += 1
                continue
                
    except KeyboardInterrupt:
        print("\n用户中断处理")
    except Exception as e:
        print(f"构建数据库过程中出错：{e}")
        raise
    finally:
        conn.close()
    
    print(f"\n" + "=" * 60)
    print(f"数据库构建完成!")
    print(f"成功处理：{processed_count} 条记录")
    print(f"失败记录：{error_count} 条")
    print(f"数据库文件：{db_path}")
    
    # 显示数据库文件大小
    if Path(db_path).exists():
        db_size_mb = Path(db_path).stat().st_size / 1024 / 1024
        print(f"数据库文件大小：{db_size_mb:.2f} MB")
    print("=" * 60)


if __name__ == "__main__":
    import sys
    
    # 默认路径
    default_json_path = Path(__file__).parent / "data" / "refactor_history.json"
    default_db_path = Path(__file__).parent / "data" / "refactor_rag.db"
    
    # 解析命令行参数
    json_file = sys.argv[1] if len(sys.argv) > 1 else str(default_json_path)
    db_file = sys.argv[2] if len(sys.argv) > 2 else str(default_db_path)
    num_records = int(sys.argv[3]) if len(sys.argv) > 3 else 100
    
    # 验证 JSON 文件是否存在
    if not Path(json_file).exists():
        print(f"错误：找不到 JSON 文件 {json_file}")
        print("\n用法：python build_db.py [json_file_path] [db_output_path] [num_records]")
        print("\n示例:")
        print("  python build_db.py data/refactor_history.json data/refactor_rag.db 100")
        sys.exit(1)
    
    # 开始构建数据库
    build_database(json_file, db_file, num_records)
