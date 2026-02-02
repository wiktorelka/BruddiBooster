let dailyChart = null;
let topAccountsChart = null;

async function renderStats() {
    try {
        const response = await fetch('/api/stats', {
            headers: { 'Authorization': localStorage.getItem('token') }
        });
        const stats = await response.json();

        renderDailyStatsChart(stats.daily);
        renderTopAccountsChart(stats.byAccount);
    } catch (error) {
        console.error('Failed to fetch stats:', error);
    }
}

function renderDailyStatsChart(dailyData) {
    const ctx = document.getElementById('dailyStatsChart').getContext('2d');
    const labels = dailyData.map(d => d.day);
    const data = dailyData.map(d => d.total_hours);

    if (dailyChart) {
        dailyChart.destroy();
    }

    dailyChart = new Chart(ctx, {
        type: 'line',
        data: {
            labels: labels,
            datasets: [{
                label: 'Hours Boosted',
                data: data,
                backgroundColor: 'rgba(59, 153, 252, 0.2)',
                borderColor: 'rgba(59, 153, 252, 1)',
                borderWidth: 1,
                tension: 0.4,
                fill: true
            }]
        },
        options: {
            responsive: true,
            scales: {
                y: {
                    beginAtZero: true
                }
            }
        }
    });
}

function renderTopAccountsChart(topAccountsData) {
    const ctx = document.getElementById('topAccountsChart').getContext('2d');
    const labels = topAccountsData.map(a => a.account_username);
    const data = topAccountsData.map(a => a.total_hours);

    if (topAccountsChart) {
        topAccountsChart.destroy();
    }

    topAccountsChart = new Chart(ctx, {
        type: 'bar',
        data: {
            labels: labels,
            datasets: [{
                label: 'Hours Boosted',
                data: data,
                backgroundColor: 'rgba(74, 222, 128, 0.2)',
                borderColor: 'rgba(74, 222, 128, 1)',
                borderWidth: 1
            }]
        },
        options: {
            responsive: true,
            indexAxis: 'y',
            scales: {
                x: {
                    beginAtZero: true
                }
            }
        }
    });
}
