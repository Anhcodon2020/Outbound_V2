import math

class Palletizer:
    def __init__(self, pallet_type="1.2", max_height=2600, pallet_base_height=170, 
                 box_len=400, box_wid=300, box_hei=200, box_weight=7, target_qty=9999, sku="SKU-001"):
        
        # Pallet Selection
        if pallet_type == "1.9":
            self.pallet_length = 1900
        else:
            self.pallet_length = 1200
        self.pallet_width = 1000
        
        self.max_height = max_height
        self.pallet_base_height = pallet_base_height
        self.usable_height = self.max_height - self.pallet_base_height
        
        # Max Weight constraint (can be large if not primarily requested)
        self.max_weight = 2000 # kg
        
        # Kích thước Thùng (mm)
        self.box_length = max(1, box_len)
        self.box_width = max(1, box_wid)
        self.box_height = max(1, box_hei)
        self.box_weight = box_weight
        self.target_qty = target_qty
        self.sku = sku
        
        # Calculate optimal patterns for interlocking
        self.patterns = self._calculate_best_layer_patterns()

    def _calculate_best_layer_patterns(self):
        """ Heuristic Block Packing algorithm for a single layer """
        max_boxes = 0
        best_layouts = []
        
        def fill_area(x0, y0, max_L, max_W, b_l, b_w, angle):
            boxes = []
            nx = int(max_L // b_l)
            ny = int(max_W // b_w)
            # Center the block within the allocated split area
            # (optional, but pushing to corner is standard. We push to corner 0,0)
            for i in range(nx):
                for j in range(ny):
                    cx = x0 + i * b_l + b_l / 2.0
                    cy = y0 + j * b_w + b_w / 2.0
                    boxes.append({'x': cx, 'y': cy, 'angle': angle})
            return boxes
            
        step = max(1, min(self.box_length, self.box_width) // 2)

        # 1. Find splits along X-axis
        for x_split in range(0, int(self.pallet_length) + 1, step):
            for left_rot in [False, True]:
                for right_rot in [False, True]:
                    b_l1, b_w1 = (self.box_width, self.box_length) if left_rot else (self.box_length, self.box_width)
                    b_l2, b_w2 = (self.box_width, self.box_length) if right_rot else (self.box_length, self.box_width)
                    
                    left_boxes = fill_area(0, 0, x_split, self.pallet_width, b_l1, b_w1, 90 if left_rot else 0)
                    right_boxes = fill_area(x_split, 0, self.pallet_length - x_split, self.pallet_width, b_l2, b_w2, 90 if right_rot else 0)
                    
                    layout = left_boxes + right_boxes
                    if len(layout) > max_boxes:
                        max_boxes = len(layout)
                        best_layouts = [layout]
                    elif len(layout) == max_boxes and max_boxes > 0:
                        # Only keep somewhat unique layouts
                        if not any(self._is_same_layout(layout, existing) for existing in best_layouts):
                            best_layouts.append(layout)
                            
        # 2. Find splits along Y-axis
        for y_split in range(0, int(self.pallet_width) + 1, step):
            for btm_rot in [False, True]:
                for top_rot in [False, True]:
                    b_l1, b_w1 = (self.box_width, self.box_length) if btm_rot else (self.box_length, self.box_width)
                    b_l2, b_w2 = (self.box_width, self.box_length) if top_rot else (self.box_length, self.box_width)
                    
                    btm_boxes = fill_area(0, 0, self.pallet_length, y_split, b_l1, b_w1, 90 if btm_rot else 0)
                    top_boxes = fill_area(0, y_split, self.pallet_length, self.pallet_width - y_split, b_l2, b_w2, 90 if top_rot else 0)
                    
                    layout = btm_boxes + top_boxes
                    if len(layout) > max_boxes:
                        max_boxes = len(layout)
                        best_layouts = [layout]
                    elif len(layout) == max_boxes and max_boxes > 0:
                        if not any(self._is_same_layout(layout, existing) for existing in best_layouts):
                            best_layouts.append(layout)

        # Trả về ít nhất 1 layout. Nếu có nhiều layout bằng nhau, giữ lại 2 cái đầu để swap
        return best_layouts

    def _is_same_layout(self, l1, l2):
        if len(l1) != len(l2): return False
        # simple check: sum of x and y coords
        sum1 = sum(b['x'] + b['y'] for b in l1)
        sum2 = sum(b['x'] + b['y'] for b in l2)
        return abs(sum1 - sum2) < 1

    def run(self):
        if not self.patterns:
            print("Không thể xếp được hộp lên pallet này do kích thước hộp lớn hơn pallet.")
            return []
            
        box_count_per_layer = len(self.patterns[0])
        max_layers_by_height = int(self.usable_height // self.box_height)
        max_layers_by_weight = int(self.max_weight // (box_count_per_layer * self.box_weight)) if box_count_per_layer > 0 else 0
        
        num_layers = min(max_layers_by_height, max_layers_by_weight)
        
        all_boxes = []
        packed_qty = 0
        
        for layer in range(num_layers):
            if packed_qty >= self.target_qty:
                break
                
            # Interlocking by swapping patterns if available, or just rotating 180 degrees
            pattern_idx = layer % len(self.patterns)
            layer_pattern = self.patterns[pattern_idx]
            
            # z value (elevation of box center)
            z_center = self.pallet_base_height + (layer * self.box_height) + (self.box_height / 2.0)
            
            layer_output = []
            for item in layer_pattern:
                if packed_qty >= self.target_qty:
                    break
                
                # Apply 180 deg rotation around center for interlocking if we only have 1 pattern
                if len(self.patterns) == 1 and layer % 2 == 1:
                    cx = self.pallet_length - item['x']
                    cy = self.pallet_width - item['y']
                    ang = item['angle']
                    # We just flip coordinates
                else:
                    cx = item['x']
                    cy = item['y']
                    ang = item['angle']

                layer_output.append((cx, cy, z_center, ang))
                packed_qty += 1
                
            all_boxes.append((layer, layer_output))
            
        print(f"Tổng số lớp xếp được: {len(all_boxes)}")
        print(f"Tổng số lượng xếp trên pallet: {packed_qty}/{self.target_qty}")
        return all_boxes


if __name__ == "__main__":
    # Test case from user specs
    palletizer = Palletizer(pallet_type="1.2", target_qty=70)
    result = palletizer.run()
    
    total = 0
    for layer_idx, boxes in result:
        print(f"\n--- Lớp {layer_idx + 1} ---")
        for x, y, z, angle in boxes:
            total += 1
            print(f"Thùng {total:02d}: Tâm(x={x:6.1f}, y={y:6.1f}, z={z:6.1f}) | Góc quay: {angle:>2} độ")
