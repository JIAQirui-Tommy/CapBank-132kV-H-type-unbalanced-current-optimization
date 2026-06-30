# 132kV H Type Capacitor Bank Unbalanced Current Optimization

Static web tool for calculating and reducing unbalanced current in a 132kV H type capacitor bank.

## Configuration

- 96 capacitors total
- Four H bridge arms: A top left, B top right, C bottom left, D bottom right
- Each arm has 24 capacitors
- Each parallel group has 4 capacitors
- Each arm has 6 parallel groups in series
- Relay / CT branch is calculated using the approximate short-circuit model

## Use

Open `index.html` in a browser, enter the measured capacitance values, choose the number of swap pairs, and run `Optimize swaps`.

